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

function detectLocalChromeWsEndpoint(): string | undefined {
    if (process.platform !== 'win32') return undefined;

    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (!localAppData) return undefined;

    const portFile = path.join(
        localAppData,
        'Google',
        'Chrome',
        'User Data',
        'DevToolsActivePort'
    );

    try {
        const [rawPort, rawPath] = fs.readFileSync(portFile, 'utf8')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);

        const port = Number(rawPort);
        if (
            Number.isInteger(port) &&
            port > 0 &&
            port <= 65535 &&
            rawPath?.startsWith('/devtools/browser/')
        ) {
            return `ws://127.0.0.1:${port}${rawPath}`;
        }
    } catch {
        // Fall through to autoConnect.
    }

    return undefined;
}

function childArgs(): string[] {
    const browserUrl = process.env.RDC_CHROME_BROWSER_URL?.trim();
    if (browserUrl) {
        return [chromeEntry, '--browserUrl', browserUrl, '--experimentalPageIdRouting'];
    }

    const wsEndpoint = detectLocalChromeWsEndpoint();
    if (wsEndpoint) {
        // Connect directly to the already-running Chrome browser target.
        // This avoids /json/version probing and avoids autoConnect discovery.
        return [chromeEntry, '--wsEndpoint', wsEndpoint, '--experimentalPageIdRouting'];
    }

    return [chromeEntry, '--autoConnect', '--experimentalPageIdRouting'];
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

        // Do not expose tools whose purpose is to change the user's foreground
        // browsing context. RDC operates existing tabs by pageId instead.
        const hiddenTools = new Set(['select_page', 'new_page']);

        cachedTools = response.tools
            .filter((tool: any) => !hiddenTools.has(tool.name))
            .map((tool: any) => {
                const schema = structuredClone(tool.inputSchema || { type: 'object', properties: {} });
                const pageScoped = !!schema?.properties?.pageId;

                if (pageScoped) {
                    schema.properties = {
                        ...(schema.properties || {}),
                        pageUrl: {
                            type: 'string',
                            description:
                                'Expected URL of the target page. RDC resolves the current pageId from this URL before every action so stale page IDs cannot target another tab.',
                        },
                    };
                    schema.required = Array.from(new Set([...(schema.required || []), 'pageUrl']));
                }

                return {
                    ...tool,
                    inputSchema: schema,
                    name: chromeToolName(tool.name),
                    title: tool.title ? `Chrome: ${tool.title}` : undefined,
                    description:
                        `Chrome DevTools on the user's already-open Chrome. ` +
                        (pageScoped
                            ? 'BACKGROUND-SAFE: always target the explicit pageId returned by chrome_list_pages; do not switch/focus the user\'s active tab. '
                            : '') +
                        `${tool.description || tool.name}`,
                };
            });

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
    const childName = childChromeToolName(name);

    if (childName === 'select_page' || childName === 'new_page') {
        return {
            content: [{
                type: 'text',
                text: 'RDC blocks Chrome foreground-switching tools. Use chrome_list_pages and target an existing tab with pageId.',
            }],
            isError: true,
        };
    }

    let exposed = cachedTools.find(tool => tool.name === name);
    if (!exposed) {
        await listChromeTools();
        exposed = cachedTools.find(tool => tool.name === name);
    }

    const pageScoped = !!exposed?.inputSchema?.properties?.pageId;
    const chrome = await connectChromeClient();

    let forwardedArgs: Record<string, unknown> = { ...(args || {}) };

    if (pageScoped) {
        const expectedUrl = typeof forwardedArgs.pageUrl === 'string'
            ? forwardedArgs.pageUrl.trim()
            : '';

        if (!expectedUrl) {
            return {
                content: [{
                    type: 'text',
                    text: 'This Chrome tool requires pageUrl in RDC background mode. Call chrome_list_pages, identify the existing target tab, then retry with its URL.',
                }],
                isError: true,
            };
        }

        const pagesResult: any = await chrome.callTool({
            name: 'list_pages',
            arguments: {},
        });
        const pagesText = pagesResult?.content?.find((item: any) => item?.type === 'text')?.text || '';
        const pageLines = String(pagesText).split(/\r?\n/);
        const pages = pageLines
            .map((line: string) => line.match(/^(\d+):\s+(\S+)(?:\s+\[selected\])?$/))
            .filter((match): match is RegExpMatchArray => match !== null)
            .map((match) => ({
                pageId: Number(match[1]),
                url: match[2],
            }));

        const exact = pages.find((page: any) => page.url === expectedUrl);
        const byOrigin = (() => {
            try {
                const target = new URL(expectedUrl);
                return pages.find((page: any) => {
                    try {
                        const candidate = new URL(page.url);
                        return candidate.origin === target.origin;
                    } catch {
                        return false;
                    }
                });
            } catch {
                return undefined;
            }
        })();

        const resolved = exact || byOrigin;

        if (!resolved) {
            return {
                content: [{
                    type: 'text',
                    text: `RDC could not find an already-open Chrome tab matching ${expectedUrl}. The action was not executed.`,
                }],
                isError: true,
            };
        }

        forwardedArgs.pageId = resolved.pageId;
        delete forwardedArgs.pageUrl;
    }

    try {
        return await chrome.callTool({
            name: childName,
            arguments: forwardedArgs,
        });
    } catch (error) {
        // Drop a stale Chrome MCP transport immediately. The next tool call will
        // start a fresh child process and reconnect to the current DevToolsActivePort
        // instead of keeping a broken client cached for the rest of the session.
        await closeChromeClient();

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
