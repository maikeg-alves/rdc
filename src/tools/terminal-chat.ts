import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const CHAT_DIR = path.join(os.homedir(), '.rdc', 'chat');
const MESSAGES_FILE = path.join(CHAT_DIR, 'messages.jsonl');
const ACKS_FILE = path.join(CHAT_DIR, 'acks.jsonl');
const REPLIES_FILE = path.join(CHAT_DIR, 'replies.jsonl');
const ACTIVE_SESSION_FILE = path.join(CHAT_DIR, 'active-session.json');
const CLAIMS_DIR = path.join(CHAT_DIR, 'claims');

const CLAIM_TTL_MS = 30000;
const IN_FLIGHT_TTL_MS = 90000;

interface TerminalMessage {
    id: string;
    sessionId?: string;
    createdAt: string;
    text: string;
}

interface TerminalAck {
    messageId: string;
    acknowledgedAt: string;
}

interface TerminalReply {
    messageId: string;
    createdAt: string;
    text: string;
}

interface ActiveTerminalSession {
    sessionId: string;
    startedAt: string;
}

async function ensureChatDir() {
    await fs.mkdir(CHAT_DIR, { recursive: true });
    await fs.mkdir(CLAIMS_DIR, { recursive: true });
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

async function readActiveSession(): Promise<ActiveTerminalSession | null> {
    try {
        const raw = await fs.readFile(ACTIVE_SESSION_FILE, 'utf8');
        const session = JSON.parse(raw) as ActiveTerminalSession;
        if (!session?.sessionId || !session?.startedAt) return null;
        return session;
    } catch {
        return null;
    }
}

function claimPath(messageId: string) {
    const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(CLAIMS_DIR, safeId + '.json');
}

async function createClaim(message: TerminalMessage): Promise<boolean> {
    await ensureChatDir();
    const filePath = claimPath(message.id);

    const create = async () => {
        const handle = await fs.open(filePath, 'wx');
        try {
            await handle.writeFile(JSON.stringify({
                messageId: message.id,
                sessionId: message.sessionId,
                claimedAt: new Date().toISOString(),
            }));
        } finally {
            await handle.close();
        }
    };

    try {
        await create();
        return true;
    } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
    }

    try {
        const stat = await fs.stat(filePath);
        if (Date.now() - stat.mtimeMs < CLAIM_TTL_MS) return false;
        await fs.unlink(filePath);
    } catch (error: any) {
        if (error?.code !== 'ENOENT') return false;
    }

    try {
        await create();
        return true;
    } catch {
        return false;
    }
}

async function releaseClaim(messageId: string) {
    try {
        await fs.unlink(claimPath(messageId));
    } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

async function findAndClaimNextTerminalMessage(): Promise<TerminalMessage | null> {
    const activeSession = await readActiveSession();
    if (!activeSession) return null;

    const [messages, acks, replies] = await Promise.all([
        readJsonl<TerminalMessage>(MESSAGES_FILE),
        readJsonl<TerminalAck>(ACKS_FILE),
        readJsonl<TerminalReply>(REPLIES_FILE),
    ]);

    const sessionMessages = messages.filter((message) => message.sessionId === activeSession.sessionId);
    const ackByMessage = new Map<string, TerminalAck>();
    for (const ack of acks) ackByMessage.set(ack.messageId, ack);
    const replied = new Set(replies.map((reply) => reply.messageId));

    for (const message of sessionMessages) {
        if (replied.has(message.id)) continue;

        const ack = ackByMessage.get(message.id);
        if (ack) {
            const acknowledgedAt = Date.parse(ack.acknowledgedAt);
            const age = Number.isFinite(acknowledgedAt) ? Date.now() - acknowledgedAt : 0;
            if (age < IN_FLIGHT_TTL_MS) return null;
            continue;
        }

        if (await createClaim(message)) {
            await appendJsonl(ACKS_FILE, {
                messageId: message.id,
                acknowledgedAt: new Date().toISOString(),
            });
            await releaseClaim(message.id);
            return message;
        }
        return null;
    }

    return null;
}

export async function getNextTerminalMessage() {
    const waitMs = 12000;
    const deadline = Date.now() + waitMs;

    let next = await findAndClaimNextTerminalMessage();
    while (!next && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 75));
        next = await findAndClaimNextTerminalMessage();
    }

    return {
        content: [{
            type: 'text' as const,
            text: next
                ? `Pending RDC terminal message: ${next.text}`
                : 'No pending RDC terminal message.',
        }],
        structuredContent: {
            message: next,
            waitedMs: waitMs,
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

    const existing = await readJsonl<TerminalAck>(ACKS_FILE);
    if (!existing.some((ack) => ack.messageId === messageId)) {
        await appendJsonl(ACKS_FILE, {
            messageId,
            acknowledgedAt: new Date().toISOString(),
        });
    }
    await releaseClaim(messageId);

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

    const existing = await readJsonl<TerminalReply>(REPLIES_FILE);
    const duplicate = existing.find((reply) => reply.messageId === messageId);
    if (duplicate) {
        return {
            content: [{ type: 'text' as const, text: `Reply already delivered to RDC terminal for ${messageId}.` }],
            structuredContent: { ok: true, duplicate: true, reply: duplicate },
        };
    }

    const reply = {
        messageId,
        createdAt: new Date().toISOString(),
        text,
    };
    await appendJsonl(REPLIES_FILE, reply);
    await releaseClaim(messageId);

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
