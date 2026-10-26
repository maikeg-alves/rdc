import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { RdcEvent } from './event-types.js';
import { redact } from './redactor.js';
import { detectSsh } from './ssh-detector.js';

const LOG_DIR = process.env.RDC_LOG_DIR || path.join(os.homedir(), '.rdc', 'logs');
const EVENT_FILE = path.join(LOG_DIR, 'events.jsonl');

function classify(tool: string, args: any): Pick<RdcEvent, 'category' | 'action' | 'target' | 'ssh'> {
    if (tool === 'start_process' || tool === 'interact_with_process' || tool === 'read_process_output') {
        const ssh = detectSsh(args?.command);
        if (ssh) return { category: 'ssh', action: 'connect', target: ssh.rawTarget, ssh };
        return { category: 'terminal', action: tool, target: typeof args?.command === 'string' ? args.command : undefined };
    }
    if (/(read|write|edit|move|directory|file)/i.test(tool)) {
        return { category: 'file', action: tool, target: args?.path ?? args?.file_path ?? args?.source ?? args?.destination };
    }
    if (/search/i.test(tool)) return { category: 'search', action: tool };
    if (/config/i.test(tool)) return { category: 'config', action: tool };
    return { category: 'other', action: tool };
}

function resultPreview(result: any): string | undefined {
    const firstText = result?.content?.find?.((item: any) => item?.type === 'text' && typeof item?.text === 'string')?.text;
    if (!firstText) return undefined;
    return firstText.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 500);
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
        args: redact(args),
    });

    return { id, startedAt };
}

export function finishToolEvent(
    context: { id: string; startedAt: number },
    tool: string,
    args: unknown,
    result: unknown,
    isError: boolean,
): void {
    const details = classify(tool, args);
    void append({
        id: context.id,
        timestamp: new Date().toISOString(),
        tool,
        status: isError ? 'error' : 'success',
        durationMs: Date.now() - context.startedAt,
        ...details,
        result: {
            isError,
            textPreview: resultPreview(result),
        },
    });
}

export function getRdcEventLogPath(): string {
    return EVENT_FILE;
}
