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
        return [chromeEntry, '--browserUrl', browserUrl, '--experimentalPageIdRouting'];
    }

    // Attach to the user's already-open Chrome and route page-scoped tools by
    // explicit pageId. This lets the agent work on a background tab without
    // stealing the user's active tab/focus.
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
                    schema.required = Array.from(new Set([...(schema.required || []), 'pageId']));
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
    if (pageScoped && (args?.pageId === undefined || args?.pageId === null)) {
        return {
            content: [{
                type: 'text',
                text: 'This Chrome tool requires pageId in RDC background mode. Call chrome_list_pages, choose the target tab, then retry with that pageId.',
            }],
            isError: true,
        };
    }

    const chrome = await connectChromeClient();

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
