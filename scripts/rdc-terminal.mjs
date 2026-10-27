#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const home = os.homedir();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');

const tunnelExe = process.env.RDC_TUNNEL_EXE || path.join(
  home, 'Downloads', 'tunnel-client-v0.0.18-windows-amd64', 'tunnel-client.exe'
);
const profileFile = process.env.RDC_PROFILE_FILE || path.join(
  home, 'AppData', 'Roaming', 'tunnel-client', 'desktop-commander.yaml'
);
const logDir = process.env.RDC_LOG_DIR || path.join(home, '.rdc', 'logs');
const eventFile = path.join(logDir, 'events.jsonl');
const rawFile = path.join(logDir, 'tunnel.log');
const pidFile = path.join(home, '.rdc', 'rdc.pid');
const chromeDevToolsPortFile = path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'DevToolsActivePort');
const healthUrl = process.env.RDC_HEALTH_URL || 'http://127.0.0.1:8080/readyz';

let debug = process.argv.includes('--debug');
const demo = process.argv.includes('--demo');
const check = process.argv.includes('--check');

fs.mkdirSync(logDir, { recursive: true });

const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  altOn: '\x1b[?1049h',
  altOff: '\x1b[?1049l',
};

const tty = Boolean(process.stdout.isTTY);
const color = (code, text) => tty ? code + text + ansi.reset : text;
const cleanAnsi = text => String(text ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
const time = iso => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString('pt-BR', { hour12: false });
};
const duration = ms => typeof ms === 'number'
  ? (ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 1 : 2) + 's' : ms + 'ms')
  : '';

function validate() {
  const checks = [
    ['tunnel-client', tunnelExe, fs.existsSync(tunnelExe)],
    ['profile', profileFile, fs.existsSync(profileFile)],
    ['fork build', path.join(root, 'dist', 'index.js'), fs.existsSync(path.join(root, 'dist', 'index.js'))],
  ];
  for (const [name, p, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${name}: ${p}`);
  }
  process.exit(checks.every(([, , ok]) => ok) ? 0 : 1);
}

if (check) validate();

function killProcessTree(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try { process.kill(Number(pid), 'SIGTERM'); } catch {}
}

function stopPreviousInstance() {
  if (!fs.existsSync(pidFile)) return;
  try {
    const previousPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (Number.isFinite(previousPid) && previousPid > 0 && previousPid !== process.pid) {
      killProcessTree(previousPid);
    }
  } catch {}
  try { fs.unlinkSync(pidFile); } catch {}
}

if (!demo) {
  stopPreviousInstance();
  fs.writeFileSync(pidFile, String(process.pid), 'utf8');
}

let child = null;
let eventOffset = fs.existsSync(eventFile) ? fs.statSync(eventFile).size : 0;
let partialEventLine = '';
let historyLines = [];
let viewportTop = 0;
let followTail = true;
let tunnelState = demo ? 'online' : 'connecting';
let mcpState = demo ? 'ready' : 'starting';
let chromeState = demo ? 'ready' : (fs.existsSync(chromeDevToolsPortFile) ? 'ready' : 'setup');
let healthDetail = demo ? 'readyz HTTP 200 · local' : 'iniciando tunnel-client...';
let lastTunnelLine = '';
let shuttingDown = false;
let headerKey = '';
let chromeReady = false;

const sessionStartedAt = Date.now();

const RDC_ART = [
  '██████╗  ██████╗  ██████╗',
  '██╔══██╗ ██╔══██╗██╔════╝',
  '██████╔╝ ██║  ██║██║     ',
  '██╔══██╗ ██║  ██║██║     ',
  '██║  ██║ ██████╔╝╚██████╗',
  '╚═╝  ╚═╝ ╚═════╝  ╚═════╝',
];

const machineName = os.hostname();
const nodeVersion = process.version;
const rdcVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || 'dev';
  } catch { return 'dev'; }
})();
const gitBranch = (() => {
  try {
    return spawnSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim() || 'detached';
  } catch { return 'unknown'; }
})();
const gitCommit = (() => {
  try {
    return spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim() || '-------';
  } catch { return '-------'; }
})();

let sessionStats = {
  started: 0,
  success: 0,
  error: 0,
  currentTool: 'idle',
  currentSince: 0,
  lastTool: 'nenhuma',
  lastDuration: undefined,
};

const HEADER_ROWS = 13;
const BODY_TOP = HEADER_ROWS + 1;

function terminalRows() {
  return Math.max(process.stdout.rows || 30, 12);
}

function terminalCols() {
  return Math.max(process.stdout.columns || 100, 72);
}

function bodyBottom() {
  return Math.max(BODY_TOP, terminalRows() - 2);
}

function footerRow() {
  return terminalRows();
}

function move(row, col = 1) {
  if (tty) process.stdout.write(`\x1b[${row};${col}H`);
}

function clearLine() {
  if (tty) process.stdout.write('\x1b[2K');
}

function stateBadge(state, kind = 'tunnel') {
  if (state === 'online' || state === 'ready') return color(ansi.green, '● ONLINE');
  if (state === 'connecting' || state === 'starting') return color(ansi.yellow, '● CONECTANDO');
  if (state === 'degraded') return color(ansi.yellow, '● DEGRADADO');
  return color(ansi.red, kind === 'mcp' ? '● PARADO' : '● OFFLINE');
}

function setupScreen() {
  if (!tty) return;
  process.stdout.write(ansi.altOn + ansi.hide + '\x1b[2J\x1b[H');
  process.stdout.write(`\x1b[${BODY_TOP};${bodyBottom()}r`);
  chromeReady = true;
  drawChrome(true);
  move(bodyBottom(), 1);
}

function formatUptime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fit(text, width) {
  const value = cleanAnsi(text);
  if (value.length <= width) return value;
  return value.slice(0, Math.max(0, width - 1)) + '…';
}

function drawChrome(force = false) {
  if (!tty) return;

  const uptime = formatUptime(Date.now() - sessionStartedAt);
  const activeFor = sessionStats.currentSince
    ? duration(Date.now() - sessionStats.currentSince)
    : '';
  const key = JSON.stringify([
    tunnelState, mcpState, chromeState, healthDetail, debug,
    terminalCols(), terminalRows(), uptime, sessionStats
  ]);
  if (!force && key === headerKey) return;
  headerKey = key;

  const cols = terminalCols();
  const inner = Math.max(20, cols - 2);
  const topLabel = ` RDC v${rdcVersion} · AGENT RUNTIME `;
  const top = '╭' + topLabel + '─'.repeat(Math.max(0, inner - topLabel.length)) + '╮';
  const bottom = '╰' + '─'.repeat(inner) + '╯';

  const chromeBadge = chromeState === 'ready'
    ? color(ansi.green, '● READY')
    : color(ansi.yellow, '● SETUP');
  const modeBadge = color(debug ? ansi.yellow : ansi.cyan, debug ? 'DEBUG' : 'AGENT');
  const ramUsedGb = ((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(1);
  const ramTotalGb = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
  const rdcMemMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const currentTool = sessionStats.currentTool === 'idle'
    ? color(ansi.gray, 'idle')
    : color(ansi.cyan, sessionStats.currentTool) + (activeFor ? color(ansi.dim, ' · ' + activeFor) : '');

  const currentBottom = bodyBottom();
  process.stdout.write('\x1b7');

  move(1); clearLine(); process.stdout.write(color(ansi.bold, top));

  for (let i = 0; i < RDC_ART.length; i++) {
    move(2 + i); clearLine();
    process.stdout.write('│  ' + color(ansi.white, RDC_ART[i]));
  }

  move(8); clearLine();
  process.stdout.write(
    '│ ' + color(ansi.dim, 'CORE') + '  ' +
    color(ansi.dim, 'Tunnel') + ' ' + stateBadge(tunnelState) + '   ' +
    color(ansi.dim, 'MCP') + ' ' + stateBadge(mcpState, 'mcp') + '   ' +
    color(ansi.dim, 'Chrome') + ' ' + chromeBadge + '   ' +
    color(ansi.dim, 'Guard') + ' ' + color(ansi.green, '● SAFE') + '   ' +
    color(ansi.dim, 'Mode') + ' ' + modeBadge
  );

  move(9); clearLine();
  process.stdout.write(
    '│ ' + color(ansi.dim, 'NODE') + '  ' +
    fit(machineName, 18) + '   ' +
    color(ansi.dim, 'git') + ' ' + fit(gitBranch, 20) + '@' + gitCommit + '   ' +
    color(ansi.dim, 'pid') + ' ' + process.pid + '   ' +
    color(ansi.dim, 'ram') + ' ' + ramUsedGb + '/' + ramTotalGb + 'G' + '   ' +
    color(ansi.dim, 'rdc') + ' ' + rdcMemMb + 'M' + '   ' +
    color(ansi.dim, 'up') + ' ' + uptime
  );

  move(10); clearLine();
  process.stdout.write(
    '│ ' + color(ansi.dim, 'TASK') + '  ' + currentTool + '   ' +
    color(ansi.dim, 'calls') + ' ' + sessionStats.started + '   ' +
    color(ansi.green, '✓ ' + sessionStats.success) + '   ' +
    color(ansi.red, '✗ ' + sessionStats.error) + '   ' +
    color(ansi.dim, 'last') + ' ' + fit(sessionStats.lastTool, 24) +
    (sessionStats.lastDuration !== undefined ? ' · ' + duration(sessionStats.lastDuration) : '')
  );

  move(11); clearLine();
  process.stdout.write('│ ' + color(ansi.dim, 'LINK') + '  ' + fit(healthDetail, Math.max(20, inner - 9)));

  move(12); clearLine(); process.stdout.write(color(ansi.bold, bottom));

  move(13); clearLine();
  process.stdout.write(
    color(ansi.gray, '   ACTIVITY') + '  ' +
    color(ansi.dim, 'comandos · arquivos · browser · ssh · resultados em tempo real')
  );

  move(footerRow()); clearLine();
  const historyState = followTail
    ? color(ansi.green, 'LIVE')
    : color(ansi.yellow, `HISTÓRICO · ${viewportTop + 1}/${Math.max(historyLines.length, 1)}`);
  process.stdout.write(
    '  ' + historyState +
    color(ansi.dim, '   ↑↓/JK navegar   PgUp/PgDn página   Home topo   G/End live   D debug   Q sair')
  );

  process.stdout.write(`\x1b[${BODY_TOP};${currentBottom}r`);
  process.stdout.write('\x1b8');
}

function bodyHeight() {
  return Math.max(1, bodyBottom() - BODY_TOP + 1);
}

function maxViewportTop() {
  return Math.max(0, historyLines.length - bodyHeight());
}

function renderViewport() {
  if (!tty) return;

  if (followTail) viewportTop = maxViewportTop();
  viewportTop = Math.max(0, Math.min(viewportTop, maxViewportTop()));

  process.stdout.write('\x1b7');
  for (let row = BODY_TOP; row <= bodyBottom(); row++) {
    move(row); clearLine();
    const index = viewportTop + (row - BODY_TOP);
    if (index < historyLines.length) {
      process.stdout.write(historyLines[index]);
    }
  }
  process.stdout.write('\x1b8');
  drawChrome(true);
}

function pushHistoryLine(line = '') {
  const raw = String(line);
  const plain = cleanAnsi(raw);
  const maxWidth = Math.max(20, terminalCols() - 1);

  if (plain.length <= maxWidth) {
    historyLines.push(raw);
  } else {
    for (let i = 0; i < plain.length; i += maxWidth) {
      historyLines.push(plain.slice(i, i + maxWidth));
    }
  }

  if (historyLines.length > 20000) {
    const removed = historyLines.length - 20000;
    historyLines = historyLines.slice(removed);
    viewportTop = Math.max(0, viewportTop - removed);
  }
}

function navigateHistory(delta) {
  followTail = false;
  viewportTop = Math.max(0, Math.min(viewportTop + delta, maxViewportTop()));
  if (viewportTop >= maxViewportTop()) followTail = true;
  renderViewport();
}

function goLive() {
  followTail = true;
  viewportTop = maxViewportTop();
  renderViewport();
}

function handleNavigationKey(key) {
  if (key === '\u001b[A' || key === 'k' || key === 'K') {
    navigateHistory(-1);
    return true;
  }
  if (key === '\u001b[B' || key === 'j' || key === 'J') {
    navigateHistory(1);
    return true;
  }
  if (key === '\u001b[5~') {
    navigateHistory(-Math.max(1, bodyHeight() - 2));
    return true;
  }
  if (key === '\u001b[6~') {
    navigateHistory(Math.max(1, bodyHeight() - 2));
    return true;
  }
  if (key === '\u001b[H' || key === '\u001b[1~') {
    followTail = false;
    viewportTop = 0;
    renderViewport();
    return true;
  }
  if (key === '\u001b[F' || key === '\u001b[4~' || key === 'g' || key === 'G') {
    goLive();
    return true;
  }
  return false;
}

function writeBody(text = '') {
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!tty) {
    process.stdout.write(normalized.endsWith('\n') ? normalized : normalized + '\n');
    return;
  }

  for (const line of normalized.split('\n')) {
    pushHistoryLine(line);
  }

  renderViewport();
}

function headline(icon, event, label, extra = '') {
  const ts = color(ansi.gray, time(event.timestamp));
  const tool = color(ansi.cyan, label);
  const suffix = extra ? color(ansi.dim, ' · ' + extra) : '';
  return ` ${icon} ${ts}  ${color(ansi.bold, 'AGENT')}  ${tool}${suffix}`;
}

function printCode(text, prefix = '    ') {
  const value = cleanAnsi(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const line of value.split('\n')) {
    writeBody(prefix + line);
  }
}

function commandOutput(text) {
  return cleanAnsi(text)
    .replace(/^Process started with PID[^\n]*\n?/im, '')
    .replace(/^Initial output:\s*\n?/im, '')
    .replace(/^✅ Process[^\n]*$/gim, '')
    .replace(/^⏳ Process[^\n]*$/gim, '')
    .replace(/^\[executed on device:[^\n]*$/gim, '')
    .replace(/^\[Reading [^\n]*\]\s*\n?/im, '')
    .trimEnd();
}

function printWifi(event) {
  const tool = event.tool;
  let data;
  try {
    data = JSON.parse(event.result?.textPreview || '{}');
  } catch {
    writeBody(headline(color(ansi.green, '✓'), event, tool, duration(event.durationMs)));
    printCode(event.result?.textPreview || '', '    ');
    writeBody('');
    return;
  }

  writeBody(headline(color(ansi.green, '✓'), event, tool, duration(event.durationMs)));

  if (tool === 'wifi_list_networks' && Array.isArray(data.networks)) {
    writeBody('    ' + color(ansi.dim, 'redes próximas') + '  ' + color(ansi.bold, String(data.networkCount ?? data.networks.length)));
    for (const network of data.networks) {
      const best = Array.isArray(network.bssids)
        ? [...network.bssids].sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1))[0]
        : undefined;
      const ssid = network.ssid || '<oculta>';
      const signal = best?.signal !== undefined ? String(best.signal).padStart(3) + '%' : ' --%';
      const channel = best?.channel !== undefined ? 'ch ' + String(best.channel).padEnd(3) : 'ch -- ';
      const security = network.authentication || network.encryption || '';
      writeBody('      ' + color(ansi.cyan, '●') + ' ' + ssid);
      writeBody('        ' + color(ansi.dim, signal + '  ' + channel + '  ' + security));
      if (best?.bssid) writeBody('        ' + color(ansi.gray, 'BSSID ' + best.bssid + (best.radioType ? ' · ' + best.radioType : '')));
    }
  } else if (tool === 'wifi_status') {
    if (data.state) writeBody('    ' + color(ansi.dim, 'estado ') + data.state);
    if (data.ssid) writeBody('    ' + color(ansi.dim, 'ssid   ') + color(ansi.bold, data.ssid));
    if (data.signal !== undefined) writeBody('    ' + color(ansi.dim, 'sinal  ') + data.signal + '%');
    if (data.channel !== undefined) writeBody('    ' + color(ansi.dim, 'canal  ') + data.channel);
    if (data.radioType) writeBody('    ' + color(ansi.dim, 'rádio  ') + data.radioType);
  }

  writeBody('');
}

function printStart(event) {
  if (!debug && event.origin === 'ui') return;

  const args = event.args || {};
  const icon = color(ansi.yellow, '●');

  if (event.category === 'wifi') {
    writeBody(headline(icon, event, event.tool));
    writeBody('    ' + color(ansi.dim, event.tool === 'wifi_status' ? 'consultando interface Wi‑Fi...' : 'procurando redes Wi‑Fi próximas...'));
    return;
  }

  if (event.category === 'terminal') {
    writeBody(headline(icon, event, event.tool));
    const command = typeof args.command === 'string' ? args.command : event.target || '';
    if (command) {
      writeBody('    ' + color(ansi.green, '❯') + ' ' + color(ansi.white, command));
    }
    return;
  }

  if (event.category === 'ssh') {
    writeBody(headline(icon, event, event.tool));
    const target = event.ssh?.rawTarget || event.target || '';
    if (target) writeBody('    ' + color(ansi.green, '❯') + ' ssh ' + target);
    return;
  }

  if (event.category === 'browser') {
    writeBody(headline(icon, event, event.tool));
    const visibleArgs = Object.fromEntries(
      Object.entries(args).filter(([key]) => key !== 'origin')
    );
    if (Object.keys(visibleArgs).length) {
      writeBody('    ' + color(ansi.dim, 'chrome'));
      printCode(JSON.stringify(visibleArgs, null, 2), '      ');
    }
    return;
  }

  if (event.category === 'file') {
    writeBody(headline(icon, event, event.tool));
    const target = event.target || args.path || args.file_path || args.source || '';
    if (target) writeBody('    ' + color(ansi.dim, 'arquivo ') + target);

    if (event.tool === 'write_file' && typeof args.content === 'string') {
      writeBody('    ' + color(ansi.dim, 'conteúdo'));
      printCode(args.content, '      ');
    } else if (event.tool === 'edit_block') {
      if (typeof args.old_string === 'string') {
        writeBody('    ' + color(ansi.red, '− anterior'));
        printCode(args.old_string, '      ');
      }
      if (typeof args.new_string === 'string') {
        writeBody('    ' + color(ansi.green, '+ novo'));
        printCode(args.new_string, '      ');
      }
    }
    return;
  }

  writeBody(headline(icon, event, event.tool));
  const keys = Object.keys(args).filter(key => key !== 'origin');
  if (keys.length) printCode(JSON.stringify(args, null, 2), '    ');
}

function printFinish(event) {
  if (!debug && event.origin === 'ui') return;

  if (event.category === 'wifi' && event.status === 'success') {
    printWifi(event);
    return;
  }

  const ok = event.status === 'success';
  const icon = color(ok ? ansi.green : ansi.red, ok ? '✓' : '✗');
  const label = ok ? 'concluído' : 'falhou';
  writeBody('    ' + icon + ' ' + color(ok ? ansi.green : ansi.red, label) +
    (event.durationMs !== undefined ? color(ansi.dim, ' · ' + duration(event.durationMs)) : ''));

  const text = event.result?.textPreview || '';

  if (!ok) {
    if (text) printCode(text, '      ');
    writeBody('');
    return;
  }

  if (event.category === 'terminal' || event.category === 'ssh') {
    const output = commandOutput(text);
    if (output) {
      writeBody('    ' + color(ansi.dim, 'saída'));
      printCode(output, '      ');
    }
    writeBody('');
    return;
  }

  if (event.category === 'browser') {
    const output = commandOutput(text);
    if (output) {
      writeBody('    ' + color(ansi.dim, 'resultado'));
      printCode(output, '      ');
    }
    writeBody('');
    return;
  }

  if (event.category === 'file') {
    if (['read_file', 'read_multiple_files', 'list_directory', 'get_file_info'].includes(event.tool)) {
      const output = commandOutput(text);
      if (output) {
        writeBody('    ' + color(ansi.dim, 'resultado'));
        printCode(output, '      ');
      }
    }
    writeBody('');
    return;
  }

  if (text && debug) {
    writeBody('    ' + color(ansi.dim, 'resultado'));
    printCode(text, '      ');
  }
  writeBody('');
}

function readNewEvents() {
  if (!fs.existsSync(eventFile)) return [];
  const stat = fs.statSync(eventFile);
  if (stat.size < eventOffset) {
    eventOffset = 0;
    partialEventLine = '';
  }
  if (stat.size === eventOffset) return [];

  const fd = fs.openSync(eventFile, 'r');
  const size = stat.size - eventOffset;
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, eventOffset);
  fs.closeSync(fd);
  eventOffset = stat.size;

  const combined = partialEventLine + buf.toString('utf8');
  const lines = combined.split(/\r?\n/);
  partialEventLine = lines.pop() || '';

  const parsed = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { parsed.push(JSON.parse(line)); } catch {}
  }
  return parsed;
}

function pollEvents() {
  for (const event of readNewEvents()) {
    if (event.status === 'started') {
      sessionStats.started += 1;
      sessionStats.currentTool = event.tool;
      sessionStats.currentSince = Date.now();
      printStart(event);
    } else {
      if (event.status === 'success') sessionStats.success += 1;
      if (event.status === 'error') sessionStats.error += 1;
      sessionStats.lastTool = event.tool;
      sessionStats.lastDuration = event.durationMs;
      if (sessionStats.currentTool === event.tool) {
        sessionStats.currentTool = 'idle';
        sessionStats.currentSince = 0;
      }
      printFinish(event);
    }
    drawChrome(true);
  }
}

function checkHealth() {
  if (demo || shuttingDown) return;

  chromeState = process.env.RDC_CHROME_BROWSER_URL || fs.existsSync(chromeDevToolsPortFile)
    ? 'ready'
    : 'setup';

  const req = http.get(healthUrl, { timeout: 800 }, res => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        tunnelState = 'online';
        healthDetail = `readyz HTTP ${res.statusCode} · ${healthUrl}`;
      } else {
        tunnelState = 'degraded';
        healthDetail = `readyz HTTP ${res.statusCode ?? '?'} · ${cleanAnsi(body).trim()}`;
      }
      drawChrome();
    });
  });

  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', () => {
    if (child && child.exitCode === null) {
      tunnelState = 'connecting';
      healthDetail = 'tunnel iniciado; aguardando readiness...';
    } else {
      tunnelState = 'offline';
      healthDetail = 'processo do tunnel não está ativo';
    }
    drawChrome();
  });
}

function cleanup(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (child?.pid) killProcessTree(child.pid);

  try {
    if (fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(pidFile);
    }
  } catch {}

  if (tty) {
    process.stdout.write('\x1b[r' + ansi.show + ansi.altOff);
  }
  process.exit(code);
}

function runDemo() {
  if (tty) setupScreen();

  printStart({
    id: '1',
    timestamp: new Date().toISOString(),
    tool: 'start_process',
    status: 'started',
    category: 'terminal',
    args: { command: 'Get-ChildItem C:\\Users\\maico\\Documents\\Projects' },
  });
  printFinish({
    id: '1',
    timestamp: new Date().toISOString(),
    tool: 'start_process',
    status: 'success',
    category: 'terminal',
    durationMs: 734,
    result: { textPreview: 'MobileFiberOps\ntrackingViaFiber\napp-isp\napi-hub\nn8n\npainel-isp' },
  });
  printWifi({
    id: '2',
    timestamp: new Date().toISOString(),
    tool: 'wifi_list_networks',
    status: 'success',
    category: 'wifi',
    durationMs: 412,
    result: {
      textPreview: JSON.stringify({
        networkCount: 2,
        networks: [
          { ssid: 'ViaFiber-5G', authentication: 'WPA2-Personal', bssids: [{ signal: 92, channel: 44, bssid: 'AA:BB:CC:DD:EE:FF', radioType: '802.11ax' }] },
          { ssid: 'Guest', authentication: 'Open', bssids: [{ signal: 51, channel: 6, bssid: '11:22:33:44:55:66', radioType: '802.11n' }] },
        ],
      }),
    },
  });

  if (!tty) process.exit(0);
}

if (demo) {
  runDemo();
  if (tty) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', key => {
      if (key === '\u0003' || key.toLowerCase() === 'q') cleanup(0);
      if (handleNavigationKey(key)) return;
    });
  }
} else {
  if (!process.env.CONTROL_PLANE_API_KEY) {
    console.error('RDC sem autenticação. Use: rdc login');
    process.exit(2);
  }

  if (tty) setupScreen();

  const raw = fs.createWriteStream(rawFile, { flags: 'a' });

  child = spawn(tunnelExe, ['run', '--profile-file', profileFile], {
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  tunnelState = 'connecting';
  mcpState = 'starting';
  healthDetail = 'iniciando tunnel-client...';
  drawChrome(true);

  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      raw.write(chunk);
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        lastTunnelLine = line;
        if (/stdio MCP command started/i.test(line)) mcpState = 'ready';
        if (/stdio MCP command exited|stdio MCP command failed/i.test(line)) mcpState = 'stopped';
        if (/tunnel-client started/i.test(line)) {
          healthDetail = 'control plane conectado; validando readiness...';
        }
      }
      drawChrome();
      if (debug && lastTunnelLine) {
        writeBody(color(ansi.gray, '    [tunnel] ' + cleanAnsi(lastTunnelLine)));
      }
    });
  }

  child.on('exit', code => {
    tunnelState = 'offline';
    mcpState = 'stopped';
    healthDetail = `tunnel-client finalizado (exit ${code ?? '?'})`;
    drawChrome(true);
    writeBody(color(ansi.red, ' ✗ tunnel finalizado'));
    if (!tty) setTimeout(() => cleanup(code ?? 1), 200);
  });

  if (tty) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', key => {
      if (key === '\u0003' || key.toLowerCase() === 'q') cleanup(0);
      if (handleNavigationKey(key)) return;
      if (key.toLowerCase() === 'd') {
        debug = !debug;
        drawChrome(true);
        writeBody(color(ansi.gray, ` debug ${debug ? 'ativado' : 'desativado'}`));
      }
    });

    process.stdout.on('resize', () => {
      process.stdout.write('\x1b[r');
      process.stdout.write(`\x1b[${BODY_TOP};${bodyBottom()}r`);
      drawChrome(true);
      renderViewport();
    });
  }

  checkHealth();
  const healthTimer = setInterval(checkHealth, 1000);
  const eventTimer = setInterval(pollEvents, 120);

  process.on('SIGINT', () => cleanup(0));
  process.on('SIGTERM', () => cleanup(0));
  process.on('exit', () => {
    clearInterval(healthTimer);
    clearInterval(eventTimer);
    try { raw.end(); } catch {}
  });
}
