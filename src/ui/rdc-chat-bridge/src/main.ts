import { createToolBridge } from '../../shared/tool-bridge.js';

type PendingMessage = {
  id: string;
  createdAt: string;
  text: string;
};

type OpenAIHost = {
  sendFollowUpMessage?: (args: { prompt: string }) => Promise<unknown> | unknown;
};

const bridge = createToolBridge({ idPrefix: 'rdc-chat', requestTimeoutMs: 20000 });
const stateEl = document.getElementById('state');
const detailEl = document.getElementById('detail');

let stopped = false;
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

async function forwardMessage(message: PendingMessage) {
  if (message.id === lastMessageId) return;

  const openai = (globalThis as unknown as { openai?: OpenAIHost }).openai;
  if (!openai?.sendFollowUpMessage) {
    throw new Error('Este host não expõe sendFollowUpMessage.');
  }

  setStatus('enviando', message.text);

  const prompt =
    `[RDC_TERMINAL messageId=${message.id}]\n` +
    `${message.text}\n\n` +
    'Esta mensagem veio do terminal RDC. Preserve a ordem da conversa. Gere a resposta e, antes de mostrar a resposta final nesta conversa, ' +
    `chame imediatamente a tool rdc_terminal_reply com messageId="${message.id}" e text contendo a resposta final completa para o terminal. ` +
    'Depois da tool, mostre a mesma resposta normalmente. Não use writing blocks para respostas vindas do RDC.';

  // getNextTerminalMessage already marks this message as received by the bridge.
  // Keep one message in flight at a time so context cannot be reordered.
  lastMessageId = message.id;
  setStatus('recebido', 'Mensagem recebida pelo bridge; aguardando resposta do ChatGPT.');

  await openai.sendFollowUpMessage({ prompt });
  setStatus('enviado', 'Mensagem encaminhada para esta conversa.');
}

async function runBridgeLoop() {
  setStatus('ativo', 'Aguardando mensagens do terminal.');

  while (!stopped) {
    try {
      const result = await bridge.callTool('rdc_terminal_next_message', {});
      const message = extractPending(result);

      if (!message) {
        setStatus('ativo', 'Aguardando mensagens do terminal.');
        continue;
      }

      await forwardMessage(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus('erro', message);

      // Short recovery delay only on failures. Normal operation has no timer gap:
      // the next long-poll starts immediately after the previous one returns.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

window.addEventListener('beforeunload', () => {
  stopped = true;
});

void runBridgeLoop();
