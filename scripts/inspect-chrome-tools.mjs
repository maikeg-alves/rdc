import { listChromeTools, closeChromeClient } from '../dist/child-mcp/chrome.js';

try {
  const tools = await listChromeTools();
  const wanted = ['chrome_list_pages','chrome_navigate_page','chrome_click','chrome_fill','chrome_evaluate_script'];
  for (const name of wanted) {
    const tool = tools.find(t => t.name === name);
    console.log('\n###', name);
    console.log(JSON.stringify(tool?.inputSchema ?? null, null, 2));
  }
} finally {
  await closeChromeClient();
}
