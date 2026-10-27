import { callChromeTool, closeChromeClient } from '../dist/child-mcp/chrome.js';

function parsePages(text) {
  return String(text || '').split('\n')
    .map(line => line.match(/^(\d+):\s+(\S+)(?:\s+\[selected\])?$/))
    .filter(Boolean)
    .map(match => ({ id: Number(match[1]), url: match[2], selected: match[0].includes('[selected]') }));
}

try {
  const before = await callChromeTool('chrome_list_pages', {});
  const beforeText = before.content?.find(x => x.type === 'text')?.text || '';
  const selectedBefore = parsePages(beforeText).find(p => p.selected);

  const result = await callChromeTool('chrome_evaluate_script', {
    pageId: 30,
    pageUrl: 'https://web.whatsapp.com/',
    function: '() => ({href: location.href, title: document.title})',
  });

  const after = await callChromeTool('chrome_list_pages', {});
  const afterText = after.content?.find(x => x.type === 'text')?.text || '';
  const selectedAfter = parsePages(afterText).find(p => p.selected);

  console.log('SELECTED_BEFORE', selectedBefore?.id, selectedBefore?.url);
  console.log('RESULT', JSON.stringify(result));
  console.log('SELECTED_AFTER', selectedAfter?.id, selectedAfter?.url);
  console.log('UNCHANGED', selectedBefore?.id === selectedAfter?.id && selectedBefore?.url === selectedAfter?.url);
} finally {
  await closeChromeClient();
}
