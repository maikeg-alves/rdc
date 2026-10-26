#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
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
const healthUrl = process.env.RDC_HEALTH_URL || 'http://127.0.0.1:8080/readyz';

const debug = process.argv.includes('--debug');
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
  gray: '\x1b[90m',
  home: '\x1b[H',
  clearBelow: '\x1b[J',
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  altOn: '\x1b[?1049h',
  altOff: '\x1b[?1049l'
};

const tty = Boolean(process.stdout.isTTY);
const c = (code, text) => tty ? code + text + ansi.reset : text;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const time = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '--:--:--'
    : d.toLocaleTimeString('pt-BR', { hour12: false });
};

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

let events = [];
let child = null;
let eventOffset = 0;
let lastRenderKey = '';
let lastTunnelLine = '';
let tunnelState = demo ? 'demo' : 'connecting';
let mcpState = demo ? 'ready' : 'starting';
let healthDetail = 'aguardando /readyz';
let shuttingDown = false;

function readEvents() {
  if (!fs.existsSync(eventFile)) return;

  const stat = fs.statSync(eventFile);
  if (stat.size < eventOffset) eventOffset = 0;
  if (stat.size === eventOffset) return;

  const fd = fs.openSync(eventFile, 'r');
  const size = stat.size - eventOffset;
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, eventOffset);
  fs.closeSync(fd);

  eventOffset = stat.size;

  for (const line of buf.toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
      if (events.length > 300) events = events.slice(-300);
    } catch {}
  }
}

function pairedEvents() {
  const byId = new Map();
  for (const event of events) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function eventLabel(e) {
  const category = (e.category || 'other').toUpperCase();

  if (e.category === 'ssh') {
    return [category, e.ssh?.rawTarget || e.target || 'SSH'];
  }

  if (e.category === 'file') {
    return [category, e.target || e.action || e.tool];
  }

  if (e.category === 'terminal') {
    let target = e.target || e.action || e.tool;

    // Hide noisy host wrapper details from the normal view.
    if (!debug && /-EncodedCommand\s+/i.test(target)) {
      target = e.action || e.tool;
    }

    return [category, target];
  }

  return [category, e.action || e.tool];
}

function statusIcon(e) {
  if (e.status === 'success') return c(ansi.green, '✓');
  if (e.status === 'error') return c(ansi.red, '✗');
  return c(ansi.yellow, '●');
}

function stateBadge(state, kind = 'tunnel') {
  if (state === 'online' || state === 'ready') return c(ansi.green, '● ONLINE');
  if (state === 'connecting' || state === 'starting') return c(ansi.yellow, '● CONECTANDO');
  if (state === 'demo') return c(ansi.cyan, '● DEMO');
  if (state === 'degraded') return c(ansi.yellow, '● DEGRADADO');
  return c(ansi.red, kind === 'mcp' ? '● PARADO' : '● OFFLINE');
}

function render(force = false) {
  readEvents();

  const width = Math.max(76, Math.min(process.stdout.columns || 100, 120));
  const line = '─'.repeat(width - 2);
  const list = pairedEvents()
    .filter(e => debug || e.origin !== 'ui')
    .slice(-10);

  const renderKey = JSON.stringify([
    tunnelState,
    mcpState,
    healthDetail,
    list.map(e => [e.id, e.status, e.durationMs, e.target, e.sessionId]),
    debug ? lastTunnelLine : ''
  ]);

  if (!force && renderKey === lastRenderKey) return;
  lastRenderKey = renderKey;

  let out = '';

  out += c(ansi.bold, '╭─ RDC · NULL ') + line.slice(0, Math.max(0, width - 15)) + '╮\n';
  out += `│ Tunnel  ${stateBadge(tunnelState)}   MCP  ${stateBadge(mcpState, 'mcp')}\n`;
  out += `│ ${c(ansi.dim, healthDetail)}\n`;
  out += '╰' + line + '╯\n\n';

  out += c(ansi.bold, ' Agente') + '\n\n';

  if (!list.length) {
    out += c(ansi.dim, '  aguardando ações do ChatGPT...') + '\n';
  } else {
    for (const e of list) {
      const duration = typeof e.durationMs === 'number' ? ` · ${e.durationMs}ms` : '';
      const toolName = e.tool || e.action || 'tool';

      out += ` ${statusIcon(e)} ${c(ansi.gray, time(e.timestamp))}  ${c(ansi.bold, 'AGENT')}  ${c(ansi.cyan, toolName)}${c(ansi.dim, duration)}\n`;

      if (e.category === 'terminal') {
        let command = e.target || '';
        if (!debug && /-EncodedCommand\s+/i.test(command)) command = e.action || e.tool;
        if (command) out += `    ${c(ansi.dim, 'comando')}  ${clip(command, width - 15)}\n`;
      } else if (e.category === 'file') {
        if (e.target) out += `    ${c(ansi.dim, 'arquivo')}  ${clip(e.target, width - 15)}\n`;
      } else if (e.category === 'ssh' && e.ssh?.host) {
        const port = e.ssh.port ? `:${e.ssh.port}` : '';
        out += `    ${c(ansi.dim, 'ssh')}      ${e.ssh.user ? e.ssh.user + '@' : ''}${e.ssh.host}${port}\n`;
      } else {
        const [, label] = eventLabel(e);
        if (label && label !== toolName) out += `    ${c(ansi.dim, 'alvo')}     ${clip(label, width - 15)}\n`;
      }

      if (e.category === 'terminal' && e.status === 'success' && e.result?.textPreview) {
        const outputLines = String(e.result.textPreview)
          .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')
          .split(/\r?\n/)
          .map(line => line.trimEnd())
          .filter(line =>
            line &&
            !/^Process started with PID\b/i.test(line) &&
            !/^Initial output:/i.test(line) &&
            !/^✅ Process\b/i.test(line) &&
            !/^⏳ Process\b/i.test(line)
          )
          .slice(0, 12);

        if (outputLines.length) out += `    ${c(ansi.dim, 'saída')}\n`;

        for (let i = 0; i < outputLines.length; i++) {
          const branch = i === outputLines.length - 1 ? '└─' : '├─';
          out += `      ${branch} ${clip(outputLines[i], width - 10)}\n`;
        }

        if (String(e.result.textPreview).split(/\r?\n/).length > outputLines.length + 3) {
          out += `      └─ ${c(ansi.dim, '… saída truncada; use rdc logs para ver mais')}\n`;
        }
      }

      if (e.status === 'error' && e.result?.textPreview) {
        out += `    ${c(ansi.red, 'erro')}    ${clip(e.result.textPreview, width - 15)}\n`;
      }

      out += '\n';
    }
  }

  out += '\n' + c(ansi.gray, line) + '\n';
  out += ` ${c(ansi.dim, 'Q/Ctrl+C sair  ·  rdc logs  ·  rdc sessions')}\n`;

  if (debug && lastTunnelLine) {
    out += ` ${c(ansi.dim, 'tunnel:')} ${clip(lastTunnelLine, width - 12)}\n`;
  }

  if (tty) {
    process.stdout.write(ansi.home + ansi.clearBelow + out);
  } else {
    // Non-interactive hosts cannot redraw. Print only when something changed.
    process.stdout.write(out);
  }
}

function checkHealth() {
  if (demo || shuttingDown) return;

  const req = http.get(healthUrl, { timeout: 800 }, (res) => {
    let body = '';

    res.setEncoding('utf8');
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        tunnelState = 'online';
        healthDetail = `readyz HTTP ${res.statusCode} · ${healthUrl}`;
      } else {
        tunnelState = 'degraded';
        healthDetail = `readyz HTTP ${res.statusCode ?? '?'} · ${clip(body, 70)}`;
      }

      render();
    });
  });

  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', () => {
    if (child && child.exitCode === null) {
      tunnelState = 'connecting';
      healthDetail = 'tunnel iniciado, aguardando readiness...';
    } else {
      tunnelState = 'offline';
      healthDetail = 'processo do tunnel não está ativo';
    }

    render();
  });
}

function seedDemo() {
  const now = Date.now();

  tunnelState = 'online';
  mcpState = 'ready';
  healthDetail = 'readyz HTTP 200 · http://127.0.0.1:8080/readyz';

  events = [
    {
      id: '1',
      timestamp: new Date(now - 5000).toISOString(),
      tool: 'read_file',
      status: 'success',
      durationMs: 42,
      category: 'file',
      target: 'C:\\Projetos\\api\\Program.cs'
    },
    {
      id: '2',
      timestamp: new Date(now - 3200).toISOString(),
      tool: 'start_process',
      status: 'success',
      durationMs: 311,
      category: 'terminal',
      target: 'dotnet build'
    },
    {
      id: '3',
      timestamp: new Date(now - 1200).toISOString(),
      tool: 'start_process',
      status: 'success',
      durationMs: 487,
      category: 'ssh',
      target: 'root@10.0.0.15',
      ssh: {
        user: 'root',
        host: '10.0.0.15',
        port: 22,
        rawTarget: 'root@10.0.0.15'
      }
    }
  ];

  render(true);
  cleanup(0);
}

function cleanup(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (child && !child.killed && child.exitCode === null) {
    child.kill();
  }

  if (tty) {
    process.stdout.write(ansi.show + ansi.altOff);
  }

  process.exit(code);
}

if (demo) {
  if (tty) process.stdout.write(ansi.altOn + ansi.hide);
  seedDemo();
}

if (!process.env.CONTROL_PLANE_API_KEY) {
  console.error('RDC sem autenticação. Use: rdc login');
  process.exit(2);
}

const raw = fs.createWriteStream(rawFile, { flags: 'a' });

child = spawn(tunnelExe, ['run', '--profile-file', profileFile], {
  env: process.env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
});

tunnelState = 'connecting';
mcpState = 'starting';
healthDetail = 'iniciando tunnel-client...';

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8');

  stream.on('data', chunk => {
    raw.write(chunk);

    const lines = chunk.split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      lastTunnelLine = line;

      if (/stdio MCP command started/i.test(line)) {
        mcpState = 'ready';
      }

      if (/stdio MCP command exited|stdio MCP command failed/i.test(line)) {
        mcpState = 'stopped';
      }

      if (/tunnel-client started/i.test(line)) {
        healthDetail = 'control plane conectado; validando readiness...';
      }
    }

    render();
  });
}

child.on('exit', code => {
  tunnelState = 'offline';
  mcpState = 'stopped';
  healthDetail = `tunnel-client finalizado (exit ${code ?? '?'})`;
  render(true);

  if (!tty) {
    setTimeout(() => cleanup(code ?? 1), 200);
  }
});

if (tty) {
  process.stdout.write(ansi.altOn + ansi.hide);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', key => {
    if (key === '\u0003' || key.toLowerCase() === 'q') cleanup(0);
  });

  process.stdout.on('resize', () => render(true));
}

render(true);
checkHealth();

const healthTimer = setInterval(checkHealth, 1000);
const eventTimer = setInterval(() => render(), 350);

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));
process.on('exit', () => {
  clearInterval(healthTimer);
  clearInterval(eventTimer);
  try { raw.end(); } catch {}
});
