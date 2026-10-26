import { listWifiNetworks, getWifiStatus } from '../dist/tools/wifi.js';

const networks = await listWifiNetworks();
const status = await getWifiStatus();

console.log('NETWORKS');
console.log(networks.content?.[0]?.text ?? networks);
console.log('STATUS');
console.log(status.content?.[0]?.text ?? status);
