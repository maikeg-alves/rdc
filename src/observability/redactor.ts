const SENSITIVE_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|credential|private[_-]?key)/i;

function redactString(value: string): string {
    return value
        .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
        .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED]')
        .replace(/([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*\s*[=:]\s*)([^\s;]+)/gi, '$1[REDACTED]');
}

export function redact(value: unknown, depth = 0): unknown {
    if (depth > 6) return '[TRUNCATED]';
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
    if (!value || typeof value !== 'object') return value;

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(child, depth + 1);
    }
    return out;
}
