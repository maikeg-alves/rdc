export type RdcEventStatus = 'started' | 'success' | 'error';

export interface RdcSshInfo {
    user?: string;
    host?: string;
    port?: number;
    rawTarget?: string;
}

export interface RdcEvent {
    id: string;
    timestamp: string;
    tool: string;
    status: RdcEventStatus;
    durationMs?: number;
    category: 'terminal' | 'ssh' | 'file' | 'search' | 'config' | 'other';
    action?: string;
    target?: string;
    ssh?: RdcSshInfo;
    sessionId?: string;
    pid?: number;
    args?: unknown;
    result?: {
        isError?: boolean;
        textPreview?: string;
    };
}
