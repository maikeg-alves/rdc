import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type WifiNetwork = {
    ssid: string;
    authentication?: string;
    encryption?: string;
    bssids: Array<{
        bssid: string;
        signal?: number;
        channel?: number;
        radioType?: string;
    }>;
};

function normalizePercent(value?: string): number | undefined {
    if (!value) return undefined;
    const n = Number(value.replace('%', '').trim());
    return Number.isFinite(n) ? n : undefined;
}

function parseNetworks(raw: string): WifiNetwork[] {
    const lines = raw.split(/\r?\n/);
    const networks: WifiNetwork[] = [];
    let current: WifiNetwork | undefined;
    let currentBssid: WifiNetwork['bssids'][number] | undefined;

    for (const original of lines) {
        const line = original.trim();
        if (!line) continue;

        const ssid = line.match(/^SSID\s+\d+\s*:\s*(.*)$/i);
        if (ssid) {
            current = { ssid: ssid[1].trim(), bssids: [] };
            networks.push(current);
            currentBssid = undefined;
            continue;
        }

        if (!current) continue;

        const auth = line.match(/^(?:Authentication|Autentica[cç][aã]o)\s*:\s*(.+)$/i);
        if (auth) {
            current.authentication = auth[1].trim();
            continue;
        }

        const encryption = line.match(/^(?:Encryption|Criptografia|Codifica[cç][aã]o)\s*:\s*(.+)$/i);
        if (encryption) {
            current.encryption = encryption[1].trim();
            continue;
        }

        const bssid = line.match(/^BSSID\s+\d+\s*:\s*([0-9a-f:.-]+)$/i);
        if (bssid) {
            currentBssid = { bssid: bssid[1] };
            current.bssids.push(currentBssid);
            continue;
        }

        if (!currentBssid) continue;

        const signal = line.match(/^(?:Signal|Sinal)\s*:\s*(\d+%)/i);
        if (signal) {
            currentBssid.signal = normalizePercent(signal[1]);
            continue;
        }

        const channel = line.match(/^(?:Channel|Canal)\s*:\s*(\d+)/i);
        if (channel) {
            currentBssid.channel = Number(channel[1]);
            continue;
        }

        const radio = line.match(/^(?:Radio type|Tipo de r[aá]dio)\s*:\s*(.+)$/i);
        if (radio) currentBssid.radioType = radio[1].trim();
    }

    return networks.filter(network => network.ssid || network.bssids.length);
}

function parseInterface(raw: string) {
    const get = (...labels: string[]) => {
        for (const label of labels) {
            const escaped = label.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
            const match = raw.match(new RegExp('^\\s*' + escaped + '\\s*:\\s*(.+)$', 'im'));
            if (match) return match[1].trim();
        }
        return undefined;
    };

    const channelValue = get('Channel', 'Canal');
    const channel = channelValue ? Number(channelValue) : NaN;

    return {
        name: get('Name', 'Nome'),
        description: get('Description', 'Descrição'),
        state: get('State', 'Estado'),
        ssid: get('SSID'),
        bssid: get('BSSID'),
        signal: normalizePercent(get('Signal', 'Sinal')),
        radioType: get('Radio type', 'Tipo de rádio'),
        channel: Number.isFinite(channel) ? channel : undefined,
        receiveRateMbps: get('Receive rate (Mbps)', 'Taxa de recebimento (Mbps)'),
        transmitRateMbps: get('Transmit rate (Mbps)', 'Taxa de transmissão (Mbps)'),
    };
}

async function runNetsh(args: string[]): Promise<string> {
    if (process.platform !== 'win32') {
        throw new Error('Wi-Fi tools currently support Windows only.');
    }

    const { stdout } = await execFileAsync('netsh.exe', args, {
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
    });

    return stdout;
}

export async function listWifiNetworks() {
    try {
        const raw = await runNetsh(['wlan', 'show', 'networks', 'mode=bssid']);
        const networks = parseNetworks(raw);

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    interfaceType: 'Wi-Fi',
                    networkCount: networks.length,
                    networks,
                }, null, 2),
            }],
        };
    } catch (error) {
        return {
            content: [{
                type: 'text' as const,
                text: `Error: Failed to scan Wi-Fi networks: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
        };
    }
}

export async function getWifiStatus() {
    try {
        const raw = await runNetsh(['wlan', 'show', 'interfaces']);
        const info = parseInterface(raw);

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify(info, null, 2),
            }],
        };
    } catch (error) {
        return {
            content: [{
                type: 'text' as const,
                text: `Error: Failed to read Wi-Fi status: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
        };
    }
}
