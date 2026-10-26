#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const home = os.homedir();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const tunnelExe = process.env.RDC_TUNNEL_EXE || path.join(home, 'Downloads', 'tunnel-client-v0.0.18-windows-amd64', 'tunnel-client.exe');
const profileFile = process.env.RDC_PROFILE_FILE || path.join(home, 'AppData', 'Roaming', 'tunnel-client', 'desktop-commander.yaml');
const logDir = process.env.RDC_LOG_DIR || path.join(home, '.rdc', 'logs');
const eventFile = path.join(logDir, 'events.jsonl');
const rawFile = path.join(logDir, 'tunnel.log');
const debug = process.argv.includes('--debug');
const demo = process.argv.includes('--demo');
const check = process.argv.includes('--check');

fs.mkdirSync(logDir, { recursive: true });

const ansi = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', blue: '\x1b[34m', gray: '\x1b[90m',
  clear: '\x1b[2J\x1b[H', hide: '\x1b[?25l', show: '\x1b[?25h'
};
const useColor = process.stdout.isTTY;
const c = (code, text) => useColor ? code + text + ansi.reset : text;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const time = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString('pt-BR', { hour12: false });
};

function validate() {
  const checks = [
    ['tunnel-client', tunnelExe, fs.existsSync(tunnelExe)],
    ['profile', profileFile, fs.existsSync(profileFile)],
    ['fork build', path.join(root, 'dist', 'index.js'), fs.existsSync(path.join(root, 'dist', 'index.js'))],
  ];
  for (const [name, p, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}: ${p}`);
  process.exit(checks.every(([, , ok]) => ok) ? 0 : 1);
}
if (check) validate();

let events = [];
let tunnelState = demo ? 'demo' : 'starting';
let lastTunnelLine = '';
let child = null;
let eventOffset = 0;
let lastRenderKey = '';

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
      if (events.length > 200) events = events.slice(-200);
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
    const target = e.ssh?.rawTarget || e.target || 'SSH';
    return [category, target];
  }
  if (e.category === 'file') return [category, e.target || e.action || e.tool];
  if (e.category === 'terminal') return [category, e.target || e.action || e.tool];
  return [category, e.action || e.tool];
}

function statusIcon(e) {
  if (e.status === 'success') return c(ansi.green, '✓');
  if (e.status === 'error') return c(ansi.red, '✗');
  return c(ansi.yellow, '●');
}

function render() {
  readEvents();
  const width = Math.max(70, Math.min(process.stdout.columns || 100, 120));
  const line = '─'.repeat(width - 2);
  const state = tunnelState === 'running' ? c(ansi.green, '● ATIVO') :
    tunnelState === 'starting' ? c(ansi.yellow, '● INICIANDO') :
    tunnelState === 'demo' ? c(ansi.cyan, '● DEMO') : c(ansi.red, '● PARADO');

  let out = '';
  if (process.stdout.isTTY) out += ansi.clear;
  out += c(ansi.bold, '╭─ RDC · NULL ') + line.slice(0, Math.max(0, width - 15)) + '╮\n';
  out += `│ ${state}  ${c(ansi.dim, 'OpenAI Secure MCP Tunnel')}  ${c(ansi.cyan, 'RDC fork')}\n`;
  out += '╰' + line + '╯\n\n';
  out += c(ansi.bold, ' Activity') + '\n\n';

  const list = pairedEvents().slice(-12);
  const renderKey = JSON.stringify([
    tunnelState,
    list.map(e => [e.id, e.status, e.durationMs, e.target, e.sessionId]),
    debug ? lastTunnelLine : ''
  ]);
  if (!process.stdout.isTTY && renderKey === lastRenderKey) return;
  lastRenderKey = renderKey;

  if (!list.length) {
    out += c(ansi.dim, '  aguardando ações do ChatGPT...') + '\n';
  } else {
    for (const e of list) {
      const [category, label] = eventLabel(e);
      const duration = typeof e.durationMs === 'number' ? ` · ${e.durationMs}ms` : '';
      out += ` ${statusIcon(e)} ${c(ansi.gray, time(e.timestamp))}  ${c(ansi.cyan, category.padEnd(8))} ${clip(label, width - 30)}${c(ansi.dim, duration)}\n`;
      if (e.category === 'ssh' && e.ssh?.host) {
        const port = e.ssh.port ? `:${e.ssh.port}` : '';
        out += `    └─ ${c(ansi.dim, `${e.ssh.user ? e.ssh.user + '@' : ''}${e.ssh.host}${port}`)}\n`;
      }
      if (e.status === 'error' && e.result?.textPreview) {
        out += `    └─ ${c(ansi.red, clip(e.result.textPreview, width - 8))}\n`;
      }
    }
  }

  out += '\n' + c(ansi.gray, line) + '\n';
  out += ` ${c(ansi.dim, 'Q/Ctrl+C sair · logs:')} ${eventFile}\n`;
  if (debug && lastTunnelLine) out += ` ${c(ansi.dim, 'tunnel:')} ${clip(lastTunnelLine, width - 12)}\n`;
  process.stdout.write(out);
}

function seedDemo() {
  const now = Date.now();
  events = [
    { id:'1', timestamp:new Date(now-5000).toISOString(), tool:'read_file', status:'success', durationMs:42, category:'file', target:'C:\\Projetos\\api\\Program.cs' },
    { id:'2', timestamp:new Date(now-3200).toISOString(), tool:'start_process', status:'success', durationMs:311, category:'terminal', target:'dotnet build' },
    { id:'3', timestamp:new Date(now-1200).toISOString(), tool:'start_process', status:'success', durationMs:487, category:'ssh', target:'root@10.0.0.15', ssh:{user:'root',host:'10.0.0.15',port:22,rawTarget:'root@10.0.0.15'} }
  ];
  render();
  process.exit(0);
}

function cleanup(code = 0) {
  if (child && !child.killed) child.kill();
  if (process.stdout.isTTY) process.stdout.write(ansi.show);
  process.exit(code);
}

if (demo) seedDemo();

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
tunnelState = 'running';

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    raw.write(chunk);
    const lines = chunk.split(/\r?\n/).filter(Boolean);
    if (lines.length) lastTunnelLine = lines.at(-1);
  });
}

child.on('exit', code => {
  tunnelState = 'stopped';
  render();
  setTimeout(() => cleanup(code ?? 1), 500);
});

if (process.stdout.isTTY) {
  process.stdout.write(ansi.hide);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', key => {
    if (key === '\u0003' || key.toLowerCase() === 'q') cleanup(0);
  });
}

render();
const timer = setInterval(render, 500);
process.on('SIGINT', () => { clearInterval(timer); cleanup(0); });
process.on('exit', () => { try { raw.end(); } catch {} });
