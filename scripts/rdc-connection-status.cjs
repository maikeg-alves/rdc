// Independent status reader: run from Remote Desktop Commander even when RDC MCP is down.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const file = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.rdc'), 'rdc', 'connection-status.json');
let s;
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch { console.log(JSON.stringify({state:'unknown',reason:'No RDC connection heartbeat recorded yet'})); process.exit(0); }
const now = Date.now();
const last = s.lastOnlineAt ? Date.parse(s.lastOnlineAt) : NaN;
const ageMs = Number.isFinite(last) ? Math.max(0,now-last) : null;
// The persisted timestamp proves last success, not the exact moment of disconnection.
const stale = ageMs !== null && ageMs > 6 * 60_000;
const state = stale && s.state === 'online' ? 'offline' : s.state;
console.log(JSON.stringify({state,lastOnlineAt:s.lastOnlineAt,offlineSince:s.offlineSince,elapsedSinceLastOnlineMs:ageMs,lastCheckedAt:s.lastCheckedAt,reason:s.reason || (stale?'heartbeat stale':undefined),estimated:stale},null,2));
