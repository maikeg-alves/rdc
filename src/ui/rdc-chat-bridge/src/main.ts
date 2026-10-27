import { createToolBridge } from '../../shared/tool-bridge.js';

type PendingMessage = {
  id: string;
  createdAt: string;
  text: string;
};

type OpenAIHost = {
  sendFollowUpMessage?: (args: { prompt: string; scrollToBottom?: boolean }) => Promise<unknown> | unknown;
  requestDisplayMode?: (args: { mode: 'inline' | 'pip' | 'fullscreen' }) => Promise<unknown> | unknown;
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

function extractReplyStatus(result: unknown) {
  if (!result || typeof result !== 'object') return { replied: false };
  const structured = (result as any).structuredContent;
  return { replied: structured?.replied === true };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTerminalReply(messageId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!stopped && Date.now() < deadline) {
    const result = await bridge.callTool('rdc_terminal_ack_message', { messageId });
    if (extractReplyStatus(result).replied) return true;
    await sleep(2000);
  }
  return false;
}

async function requestDeliveryRepair(message: PendingMessage) {
  const openai = (globalThis as unknown as { openai?: OpenAIHost }).openai;
  if (!openai?.sendFollowUpMessage) return;

  await openai.sendFollowUpMessage({
    prompt:
      `[RDC_DELIVERY_REPAIR messageId=${message.id}]\n` +
      'A resposta anterior para esta mensagem já foi gerada no chat, mas não chegou ao terminal RDC. ' +
      `Não responda novamente ao conteúdo. Apenas chame rdc_terminal_reply com messageId="${message.id}" ` +
      'e use como text exatamente a resposta final que você acabou de dar para essa mensagem.',
    scrollToBottom: false,
  });
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

  await openai.sendFollowUpMessage({ prompt, scrollToBottom: false });
  setStatus('aguardando', 'Mensagem entregue ao ChatGPT; aguardando retorno ao terminal.');

  let replied = await waitForTerminalReply(message.id, 45000);
  if (!replied) {
    setStatus('reparando', 'A resposta apareceu no chat, mas ainda não voltou ao terminal. Tentando reparar a entrega.');
    await requestDeliveryRepair(message);
    replied = await waitForTerminalReply(message.id, 15000);
  }

  setStatus(
    replied ? 'concluído' : 'erro',
    replied
      ? 'Resposta entregue ao terminal RDC.'
      : 'A resposta não voltou ao terminal dentro do prazo; a fila seguirá sem reenviar esta mensagem.'
  );
}

async function runBridgeLoop() {
  const openai = (globalThis as unknown as { openai?: OpenAIHost }).openai;
  if (openai?.requestDisplayMode) {
    try {
      await openai.requestDisplayMode({ mode: 'pip' });
    } catch {
      // PiP is best-effort; keep the bridge working inline if the host declines.
    }
  }

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
