import { startProcess } from '../dist/tools/improved-process-tools.js';

const commands = [
  "Start-Process chrome.exe 'https://web.whatsapp.com/'",
  "$ws=New-Object -ComObject WScript.Shell; $ws.AppActivate('WhatsApp'); $ws.SendKeys('^f')"
];

for (const command of commands) {
  const result = await startProcess({ command, timeout_ms: 1000 });
  console.log(command);
  console.log(JSON.stringify(result));
}
