import type { RdcSshInfo } from './event-types.js';

const OPTIONS_WITH_VALUE = new Set([
    '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L',
    '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'
]);

function stripQuotes(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}

export function detectSsh(command: unknown): RdcSshInfo | undefined {
    if (typeof command !== 'string') return undefined;

    const match = command.match(/(?:^|[;&|]\s*)ssh\s+(.+)$/i);
    if (!match) return undefined;

    const tokens = match[1].match(/"[^"]*"|'[^']*'|\S+/g)?.map(stripQuotes) ?? [];
    let target: string | undefined;
    let port: number | undefined;
    let optionUser: string | undefined;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (token === '--') {
            target = tokens[i + 1];
            break;
        }

        if (token === '-p' && tokens[i + 1]) {
            const parsed = Number(tokens[++i]);
            if (Number.isFinite(parsed)) port = parsed;
            continue;
        }

        if (token.startsWith('-p') && token.length > 2) {
            const parsed = Number(token.slice(2));
            if (Number.isFinite(parsed)) port = parsed;
            continue;
        }

        if (token === '-l' && tokens[i + 1]) {
            optionUser = tokens[++i];
            continue;
        }

        if (OPTIONS_WITH_VALUE.has(token)) {
            i += 1;
            continue;
        }

        if (token.startsWith('-')) continue;

        target = token;
        break;
    }

    if (!target) return undefined;

    const at = target.lastIndexOf('@');
    const user = at > 0 ? target.slice(0, at) : optionUser;
    let host = at > 0 ? target.slice(at + 1) : target;
    host = host.replace(/^\[|\]$/g, '');

    if (!host) return undefined;

    return {
        user,
        host,
        port,
        rawTarget: user ? `${user}@${host}` : host,
    };
}
