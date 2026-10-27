import { createToolBridge } from '../../shared/tool-bridge.js';

type PendingMessage = {
  id: string;
  createdAt: string;
  text: string;
};

type OpenAIHost = {
  sendFollowUpMessage?: (args: { prompt: string }) => Promise<unknown> | unknown;
};

const bridge = createToolBridge({ idPrefix: 'rdc-chat' });
const stateEl = document.getElementById('state');
const detailEl = document.getElementById('detail');

let busy = false;
let lastMessageId = '';

function setStatus(state: string, detail: string) {
  if (stateEl) stateEl.textContent = state;
  if (detailEl) detailEl.textContent = detail;
}

function extractPending(result: unknown): PendingMessage | null {
  if (!result || typeof result !== 'object') return null;
  const structured = (result as any).structuredContent;
  const message = structured?.message;
  if (!message || typeof message !== 'object') return null;
  if (typeof message.id !== 'string' || typeof message.text !== 'string') return null;
  return message as PendingMessage;
}

async function forwardPendingMessage() {
  if (busy) return;
  busy = true;

  try {
    const result = await bridge.callTool('rdc_terminal_next_message', {});
    const message = extractPending(result);

    if (!message) {
      setStatus('ativo', 'Aguardando mensagens do terminal.');
      return;
    }

    if (message.id === lastMessageId) {
      return;
    }

    const openai = (globalThis as unknown as { openai?: OpenAIHost }).openai;
    if (!openai?.sendFollowUpMessage) {
      setStatus('sem suporte', 'Este host não expõe sendFollowUpMessage.');
      return;
    }

    setStatus('enviando', message.text);

    const prompt =
      `[RDC_TERMINAL messageId=${message.id}]\n` +
      `${message.text}\n\n` +
      'Esta mensagem veio do terminal RDC. Responda normalmente nesta conversa e, ao finalizar, ' +
      `chame a tool rdc_terminal_reply com messageId="${message.id}" e text contendo a resposta final completa para o terminal.`;

    await openai.sendFollowUpMessage({ prompt });
    await bridge.callTool('rdc_terminal_ack_message', { messageId: message.id });

    lastMessageId = message.id;
    setStatus('enviado', 'Mensagem encaminhada para esta conversa.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus('erro', message);
  } finally {
    busy = false;
  }
}

setStatus('ativo', 'Aguardando mensagens do terminal.');
void forwardPendingMessage();
setInterval(() => void forwardPendingMessage(), 1000);
