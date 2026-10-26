import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { RdcEvent } from './event-types.js';
import { redact } from './redactor.js';
import { detectSsh } from './ssh-detector.js';
import { closeSshSession, getSshSession, registerSshSession } from './session-tracker.js';

const LOG_DIR = process.env.RDC_LOG_DIR || path.join(os.homedir(), '.rdc', 'logs');
const EVENT_FILE = path.join(LOG_DIR, 'events.jsonl');

type EventDetails = Pick<RdcEvent, 'category' | 'action' | 'target' | 'ssh' | 'sessionId' | 'pid'>;

function numericPid(args: any): number | undefined {
    const value = Number(args?.pid);
    return Number.isFinite(value) ? value : undefined;
}

function classify(tool: string, args: any): EventDetails {
    const pid = numericPid(args);

    if (pid !== undefined) {
        const session = getSshSession(pid);
        if (session) {
            return {
                category: 'ssh',
                action: tool,
                target: session.ssh.rawTarget,
                ssh: session.ssh,
                sessionId: session.id,
                pid,
            };
        }
    }

    if (tool === 'start_process' || tool === 'interact_with_process' || tool === 'read_process_output') {
        const ssh = detectSsh(args?.command);
        if (ssh) return { category: 'ssh', action: 'connect', target: ssh.rawTarget, ssh, pid };
        return {
            category: 'terminal',
            action: tool,
            target: typeof args?.command === 'string' ? args.command : undefined,
            pid,
        };
    }

    if (/(read|write|edit|move|directory|file)/i.test(tool)) {
        return {
            category: 'file',
            action: tool,
            target: args?.path ?? args?.file_path ?? args?.source ?? args?.destination,
            pid,
        };
    }

    if (/search/i.test(tool)) return { category: 'search', action: tool, pid };
    if (/config/i.test(tool)) return { category: 'config', action: tool, pid };
    return { category: 'other', action: tool, pid };
}

function resultPreview(result: any, maxLength = 500): string | undefined {
    const firstText = result?.content?.find?.((item: any) => item?.type === 'text' && typeof item?.text === 'string')?.text;
    if (!firstText) return undefined;
    return firstText.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '').slice(0, maxLength);
}

async function append(event: RdcEvent): Promise<void> {
    try {
        await fs.mkdir(LOG_DIR, { recursive: true });
        await fs.appendFile(EVENT_FILE, JSON.stringify(redact(event)) + '\n', 'utf8');
    } catch {
        // Observability must never break a tool call.
    }
}

export function startToolEvent(tool: string, args: unknown): { id: string; startedAt: number } {
    const id = randomUUID();
    const startedAt = Date.now();
    const details = classify(tool, args);

    void append({
        id,
        timestamp: new Date(startedAt).toISOString(),
        tool,
        status: 'started',
        ...details,
        origin: args && typeof args === 'object' ? (args as any).origin : undefined,
        args: redact(args),
    });

    return { id, startedAt };
}

export function finishToolEvent(
    context: { id: string; startedAt: number },
    tool: string,
    args: any,
    result: unknown,
    isError: boolean,
): void {
    let registeredSession;
    if (!isError && tool === 'start_process') {
        registeredSession = registerSshSession(args?.command, result);
    }

    let details = classify(tool, args);
    if (registeredSession) {
        details = {
            ...details,
            category: 'ssh',
            action: 'connect',
            target: registeredSession.ssh.rawTarget,
            ssh: registeredSession.ssh,
            sessionId: registeredSession.id,
            pid: registeredSession.pid,
        };
    }

    void append({
        id: context.id,
        timestamp: new Date().toISOString(),
        tool,
        status: isError ? 'error' : 'success',
        durationMs: Date.now() - context.startedAt,
        ...details,
        origin: args && typeof args === 'object' ? args.origin : undefined,
        result: {
            isError,
            textPreview: resultPreview(
                result,
                tool === 'start_process' || tool === 'read_process_output' || tool === 'interact_with_process'
                    ? 8000
                    : 500
            ),
        },
    });

    if (tool === 'force_terminate' || tool === 'kill_process') {
        closeSshSession(args?.pid);
    }
}

export function getRdcEventLogPath(): string {
    return EVENT_FILE;
}
