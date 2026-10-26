import { randomUUID } from 'crypto';
import type { RdcSshInfo } from './event-types.js';
import { detectSsh } from './ssh-detector.js';

export interface RdcSshSession {
    id: string;
    pid: number;
    ssh: RdcSshInfo;
    startedAt: string;
}

const sshSessions = new Map<number, RdcSshSession>();

function resultText(result: any): string {
    return result?.content
        ?.filter?.((item: any) => item?.type === 'text' && typeof item?.text === 'string')
        ?.map?.((item: any) => item.text)
        ?.join?.('\n') ?? '';
}

export function registerSshSession(command: unknown, result: unknown): RdcSshSession | undefined {
    const ssh = detectSsh(command);
    if (!ssh) return undefined;

    const text = resultText(result);
    const pidMatch = text.match(/PID\s+(\d+)/i);
    if (!pidMatch) return undefined;

    const pid = Number(pidMatch[1]);
    if (!Number.isFinite(pid)) return undefined;

    const existing = sshSessions.get(pid);
    if (existing) return existing;

    const session: RdcSshSession = {
        id: randomUUID(),
        pid,
        ssh,
        startedAt: new Date().toISOString(),
    };
    sshSessions.set(pid, session);
    return session;
}

export function getSshSession(pid: unknown): RdcSshSession | undefined {
    const numericPid = typeof pid === 'number' ? pid : Number(pid);
    if (!Number.isFinite(numericPid)) return undefined;
    return sshSessions.get(numericPid);
}

export function closeSshSession(pid: unknown): RdcSshSession | undefined {
    const session = getSshSession(pid);
    if (session) sshSessions.delete(session.pid);
    return session;
}
