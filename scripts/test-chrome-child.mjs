import { listChromeTools, callChromeTool, closeChromeClient } from '../dist/child-mcp/chrome.js';

try {
  const tools = await listChromeTools();
  console.log('TOOLS', tools.length);
  console.log(tools.slice(0, 20).map(tool => tool.name).join('\n'));

  if (tools.some(tool => tool.name === 'chrome_list_pages')) {
    const result = await callChromeTool('chrome_list_pages', {});
    console.log('LIST_PAGES');
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await closeChromeClient();
}
