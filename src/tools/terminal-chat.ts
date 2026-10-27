import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const CHAT_DIR = path.join(os.homedir(), '.rdc', 'chat');
const MESSAGES_FILE = path.join(CHAT_DIR, 'messages.jsonl');
const ACKS_FILE = path.join(CHAT_DIR, 'acks.jsonl');
const REPLIES_FILE = path.join(CHAT_DIR, 'replies.jsonl');

interface TerminalMessage {
    id: string;
    createdAt: string;
    text: string;
}

interface TerminalAck {
    messageId: string;
    acknowledgedAt: string;
}

async function ensureChatDir() {
    await fs.mkdir(CHAT_DIR, { recursive: true });
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return raw
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => {
                try { return JSON.parse(line) as T; } catch { return null; }
            })
            .filter((value): value is T => value !== null);
    } catch (error: any) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
}

async function appendJsonl(filePath: string, value: unknown) {
    await ensureChatDir();
    await fs.appendFile(filePath, JSON.stringify(value) + '\n', 'utf8');
}

export async function getNextTerminalMessage() {
    const [messages, acks] = await Promise.all([
        readJsonl<TerminalMessage>(MESSAGES_FILE),
        readJsonl<TerminalAck>(ACKS_FILE),
    ]);

    const acknowledged = new Set(acks.map((ack) => ack.messageId));
    const next = messages.find((message) => !acknowledged.has(message.id));

    return {
        content: [{
            type: 'text' as const,
            text: next
                ? `Pending RDC terminal message: ${next.text}`
                : 'No pending RDC terminal message.',
        }],
        structuredContent: {
            message: next ?? null,
        },
    };
}

export async function acknowledgeTerminalMessage(args: unknown) {
    const messageId = typeof (args as any)?.messageId === 'string'
        ? (args as any).messageId.trim()
        : '';

    if (!messageId) {
        return {
            content: [{ type: 'text' as const, text: 'Error: messageId is required.' }],
            isError: true,
        };
    }

    await appendJsonl(ACKS_FILE, {
        messageId,
        acknowledgedAt: new Date().toISOString(),
    });

    return {
        content: [{ type: 'text' as const, text: `Acknowledged RDC terminal message ${messageId}.` }],
        structuredContent: { ok: true, messageId },
    };
}

export async function replyToTerminal(args: unknown) {
    const messageId = typeof (args as any)?.messageId === 'string'
        ? (args as any).messageId.trim()
        : '';
    const text = typeof (args as any)?.text === 'string'
        ? (args as any).text.trim()
        : '';

    if (!messageId || !text) {
        return {
            content: [{ type: 'text' as const, text: 'Error: messageId and text are required.' }],
            isError: true,
        };
    }

    const reply = {
        messageId,
        createdAt: new Date().toISOString(),
        text,
    };
    await appendJsonl(REPLIES_FILE, reply);

    return {
        content: [{ type: 'text' as const, text: `Reply delivered to RDC terminal for ${messageId}.` }],
        structuredContent: { ok: true, reply },
    };
}

export function getChatBridgeStatus() {
    return {
        content: [{
            type: 'text' as const,
            text: 'RDC terminal bridge is active for this conversation.',
        }],
        structuredContent: {
            active: true,
            mode: 'single-conversation',
        },
    };
}
