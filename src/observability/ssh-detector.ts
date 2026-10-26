import type { RdcSshInfo } from './event-types.js';

export function detectSsh(command: unknown): RdcSshInfo | undefined {
    if (typeof command !== 'string') return undefined;

    const match = command.match(/(?:^|[;&|]\s*)ssh\s+(?:[^\s]+\s+)*?(?:(?<user>[A-Za-z0-9._-]+)@)?(?<host>\[[^\]]+\]|[A-Za-z0-9._:-]+)(?:\s|$)/i);
    if (!match?.groups?.host) return undefined;

    const portMatch = command.match(/(?:^|\s)-p\s+(\d{1,5})(?:\s|$)/i);
    const port = portMatch ? Number(portMatch[1]) : undefined;
    const host = match.groups.host.replace(/^\[|\]$/g, '');

    return {
        user: match.groups.user,
        host,
        port,
        rawTarget: match.groups.user ? `${match.groups.user}@${host}` : host,
    };
}
