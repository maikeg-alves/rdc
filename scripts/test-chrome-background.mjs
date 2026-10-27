import { listChromeTools, callChromeTool, closeChromeClient } from '../dist/child-mcp/chrome.js';

function parsePages(text) {
  return String(text || '').split('\n')
    .map(line => line.match(/^(\d+):\s+(\S+)(?:\s+\[selected\])?$/))
    .filter(Boolean)
    .map(match => ({
      id: Number(match[1]),
      url: match[2],
      selected: match[0].includes('[selected]'),
    }));
}

try {
  const tools = await listChromeTools();
  console.log('TOOLS', tools.length);
  console.log('HAS_SELECT_PAGE', tools.some(t => t.name === 'chrome_select_page'));
  console.log('HAS_NEW_PAGE', tools.some(t => t.name === 'chrome_new_page'));
  console.log('EVAL_REQUIRES_PAGE_ID', tools.find(t => t.name === 'chrome_evaluate_script')?.inputSchema?.required?.includes('pageId'));

  const before = await callChromeTool('chrome_list_pages', {});
  const beforeText = before.content?.find(x => x.type === 'text')?.text || '';
  const beforePages = parsePages(beforeText);
  const selectedBefore = beforePages.find(p => p.selected);
  const whatsapp = beforePages.find(p => p.url.includes('web.whatsapp.com'));

  console.log('SELECTED_BEFORE', selectedBefore?.id, selectedBefore?.url);
  console.log('WHATSAPP_PAGE', whatsapp?.id, whatsapp?.url);

  if (!whatsapp) throw new Error('WhatsApp tab not found');

  const title = await callChromeTool('chrome_evaluate_script', {
    pageId: whatsapp.id,
    function: '() => document.title',
  });
  console.log('BACKGROUND_EVAL', JSON.stringify(title));

  const after = await callChromeTool('chrome_list_pages', {});
  const afterText = after.content?.find(x => x.type === 'text')?.text || '';
  const selectedAfter = parsePages(afterText).find(p => p.selected);
  console.log('SELECTED_AFTER', selectedAfter?.id, selectedAfter?.url);
  console.log('UNCHANGED', selectedBefore?.id === selectedAfter?.id);
} finally {
  await closeChromeClient();
}
