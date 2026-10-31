/** Durable, best-effort status for independent troubleshooting via Remote Desktop Commander. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const path = join(process.env.LOCALAPPDATA || join(homedir(), '.rdc'), 'rdc', 'connection-status.json');
export type ConnectionStatus = {
  version: 1;
  state: 'online' | 'offline' | 'unstable';
  lastOnlineAt: string | null;
  offlineSince: string | null;
  lastCheckedAt: string;
  reason?: string;
};
export function readConnectionStatus(): ConnectionStatus | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as ConnectionStatus; }
  catch { return null; }
}
export function writeConnectionStatus(state: ConnectionStatus['state'], reason?: string): void {
  try {
    const previous = readConnectionStatus();
    const now = new Date().toISOString();
    const data: ConnectionStatus = {
      version: 1, state,
      lastOnlineAt: state === 'online' ? now : previous?.lastOnlineAt ?? null,
      offlineSince: state === 'online' ? null : previous?.offlineSince ?? now,
      lastCheckedAt: now, ...(reason ? { reason } : {}),
    };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  } catch { /* status recording must never break the remote connection */ }
}
