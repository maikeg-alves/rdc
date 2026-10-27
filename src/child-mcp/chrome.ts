import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TOOL_PREFIX = 'chrome_';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const chromeEntry = path.join(
    projectRoot,
    'node_modules',
    'chrome-devtools-mcp',
    'build',
    'src',
    'bin',
    'chrome-devtools-mcp.js'
);

let client: Client | undefined;
let transport: StdioClientTransport | undefined;
let connecting: Promise<Client> | undefined;
let cachedTools: any[] = [];

function childArgs(): string[] {
    const browserUrl = process.env.RDC_CHROME_BROWSER_URL?.trim();
    if (browserUrl) {
        return [chromeEntry, '--browserUrl', browserUrl];
    }

    // Chrome DevTools MCP 0.23+ can attach to an already-open Chrome 144+
    // once remote debugging is enabled at chrome://inspect/#remote-debugging.
    return [chromeEntry, '--autoConnect'];
}

async function connectChromeClient(): Promise<Client> {
    if (client) return client;
    if (connecting) return connecting;

    connecting = (async () => {
        if (!fs.existsSync(chromeEntry)) {
            throw new Error(
                'chrome-devtools-mcp is not installed. Run npm install in the RDC project.'
            );
        }

        const nextClient = new Client(
            { name: 'rdc-chrome-bridge', version: '1.0.0' },
            { capabilities: {} }
        );

        const nextTransport = new StdioClientTransport({
            command: process.execPath,
            args: childArgs(),
            env: {
                ...process.env,
                CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS:
                    process.env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS || '1',
            } as Record<string, string>,
            stderr: 'pipe',
            maxBufferSize: 50 * 1024 * 1024,
        });

        nextTransport.onerror = () => {
            client = undefined;
            transport = undefined;
            cachedTools = [];
        };
        nextTransport.onclose = () => {
            client = undefined;
            transport = undefined;
            cachedTools = [];
        };

        await nextClient.connect(nextTransport);

        client = nextClient;
        transport = nextTransport;
        return nextClient;
    })();

    try {
        return await connecting;
    } finally {
        connecting = undefined;
    }
}

export function isChromeTool(name: string): boolean {
    return name.startsWith(TOOL_PREFIX);
}

export function chromeToolName(childName: string): string {
    return TOOL_PREFIX + childName;
}

export function childChromeToolName(exposedName: string): string {
    return exposedName.slice(TOOL_PREFIX.length);
}

export async function listChromeTools(): Promise<any[]> {
    try {
        const chrome = await connectChromeClient();
        const response = await chrome.listTools();

        cachedTools = response.tools.map((tool: any) => ({
            ...tool,
            name: chromeToolName(tool.name),
            title: tool.title ? `Chrome: ${tool.title}` : undefined,
            description:
                `Chrome DevTools (existing Chrome session): ${tool.description || tool.name}`,
        }));

        return cachedTools;
    } catch {
        cachedTools = [];
        return [];
    }
}

export async function callChromeTool(
    name: string,
    args: Record<string, unknown> | undefined
): Promise<any> {
    const chrome = await connectChromeClient();
    const childName = childChromeToolName(name);

    try {
        return await chrome.callTool({
            name: childName,
            arguments: args || {},
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const autoConnectHint =
            'Abra chrome://inspect/#remote-debugging no Chrome que você já usa e habilite Remote Debugging.';

        return {
            content: [{
                type: 'text',
                text: `Chrome DevTools MCP error: ${message}\n\n${autoConnectHint}`,
            }],
            isError: true,
        };
    }
}

export async function closeChromeClient(): Promise<void> {
    const currentTransport = transport;
    client = undefined;
    transport = undefined;
    cachedTools = [];

    if (currentTransport) {
        try {
            await currentTransport.close();
        } catch {}
    }
}

export function getCachedChromeTools(): any[] {
    return cachedTools;
}
