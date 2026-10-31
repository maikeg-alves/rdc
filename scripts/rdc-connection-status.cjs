// Independent RDC diagnostic, readable while the RDC MCP is disconnected.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const file = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.rdc'), 'rdc', 'connection-status.json');
let s;
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch {
  console.log(JSON.stringify({state:'unknown',message:'RDC sem histórico de conexão nesta instalação',lastOnlineAt:null,elapsedSinceLastOnlineMs:null}));
  process.exit(0);
}
const timestamp = s.lastOnlineAt ? Date.parse(s.lastOnlineAt) : NaN;
const ageMs = Number.isFinite(timestamp) ? Math.max(0, Date.now()-timestamp) : null;
const lastCheck = s.lastCheckedAt ? Date.parse(s.lastCheckedAt) : NaN;
const stale = !Number.isFinite(lastCheck) || Date.now()-lastCheck > 6*60_000;
const state = stale ? 'unknown' : s.state;
const formatDuration = ms => ms === null ? 'desconhecido' : Math.floor(ms/3600000)+'h '+Math.floor((ms%3600000)/60000)+'min '+Math.floor((ms%60000)/1000)+'s';
const msg = state === 'online' ? 'Última atualização do RDC indica conexão online' :
  state === 'offline' ? 'RDC offline (desconexão registrada)' :
  state === 'unstable' ? 'RDC com conexão instável' : 'RDC sem heartbeat recente; estado atual não confirmado';
const result = {
 state, message:msg, lastOnlineAt:s.lastOnlineAt, offlineSince:s.offlineSince,
 elapsedSinceLastOnlineMs:ageMs, elapsedSinceLastOnline:formatDuration(ageMs),
 lastCheckedAt:s.lastCheckedAt, isHeartbeatStale:stale,
 note:'Tempo desde o último contato registrado, não duração exata da queda. Consulte disponibilidade em tempo real separadamente.'
};
console.log(JSON.stringify(result,null,2));