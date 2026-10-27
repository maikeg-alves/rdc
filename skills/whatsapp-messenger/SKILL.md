---
name: whatsapp-messenger
version: 0.1.0
audience: agent
description: >-
  Send a message through the user's already-open WhatsApp Web using RDC Chrome
  DevTools, verify that it was actually sent, then wait for and report the next
  reply from that same chat. Use this for requests like "manda no WhatsApp",
  "envia isso para fulano/grupo", "manda no grupo Notas e espera resposta",
  "me avisa quando responder", or follow-ups after a prepared WhatsApp message.
  Prefer this skill over generic browser automation for WhatsApp messaging.
---

# WhatsApp Messenger

Use the user's existing authenticated WhatsApp Web tab through RDC's Chrome
DevTools tools. The goal is narrow and deterministic:

1. identify the requested chat,
2. prepare the exact outbound text,
3. get confirmation when required,
4. send exactly once,
5. verify the send,
6. wait for the next reply from that same chat,
7. report the reply.

Do not browse unrelated chats, contacts, media, or history.

## Safety and confirmation

WhatsApp sending is an external side effect.

- Before the final send, state the exact destination and exact message text and
  wait for explicit approval, unless the user has already just approved that
  exact prepared send in the immediately preceding turn.
- A reply like "pode", "manda", "envia" after the exact destination/content was
  prepared is sufficient confirmation.
- If the destination or content changes materially, confirm again.
- Never send twice because a tool timed out or disconnected. Verify the chat
  history first before retrying.
- Do not send to a similarly named chat unless the requested destination is
  unambiguous in the current WhatsApp UI.

## Required Chrome workflow

Always target the existing WhatsApp Web page by URL. Do not create a new tab and
do not focus-steal.

### 1. Find WhatsApp Web

Call `chrome_list_pages` and find:

`https://web.whatsapp.com/`

Use the current returned `pageId` plus `pageUrl` on every subsequent Chrome
tool call. Treat page IDs as ephemeral.

If WhatsApp Web is not open, tell the user to open/log in to WhatsApp Web. Do
not open a fresh unauthenticated browser profile.

### 2. Snapshot before acting

Call `chrome_take_snapshot` for WhatsApp Web.

Locate the requested chat in the chat list. Prefer the exact visible chat name,
for example:

- `Notas`
- `João`
- `Equipe TI`

Click that chat with `chrome_click`, then immediately take a fresh snapshot.
Never reuse element UIDs from a snapshot taken before navigating to the chat.

Confirm the chat header matches the intended recipient/group before typing.

### 3. Record a baseline for reply detection

Before sending, capture the current recent-message tail with either:

- `chrome_take_snapshot`, or
- `chrome_evaluate_script` reading only the last ~10-20 `[role="row"]`
  elements.

Keep enough baseline information to distinguish newly arrived messages from
messages that were already present.

### 4. Type the message the WhatsApp-safe way

For WhatsApp's contenteditable composer, prefer this sequence:

1. click the current composer textbox,
2. call `chrome_type_text` with the exact message,
3. set `submitKey: "Enter"`.

Do **not** rely on `chrome_fill` for the WhatsApp composer. In practice it can
report success while leaving the contenteditable field empty.

If the message contains multiple lines, `chrome_type_text` may cause WhatsApp
to send each newline-separated line as its own message depending on editor
behavior. Preserve the user's intended formatting, but verify the actual result
after sending.

### 5. Verify the send before claiming success

After the send, inspect WhatsApp again.

Use `chrome_evaluate_script` or a fresh snapshot to verify that the intended
text appears in the active chat's recent rows and that the composer is empty.

A useful bounded check is:

```js
() => ({
  composer: [...document.querySelectorAll('[contenteditable="true"]')]
    .map(e => ({ aria: e.getAttribute('aria-label'), text: e.innerText }))
    .slice(-5),
  tail: [...document.querySelectorAll('[role="row"]')]
    .slice(-20)
    .map(e => e.innerText)
})
```

Only tell the user "enviado" after this verification succeeds.

If a Chrome/MCP error occurs after typing but before verification, **do not
automatically resend**. Reconnect, inspect the active chat, and determine whether
the message already appears. Retry the send only if it is clearly absent.

## Waiting for a reply

After a verified send, remain scoped to the same chat.

### Polling behavior

- Poll with a fresh snapshot or bounded `chrome_evaluate_script`.
- Use a calm cadence such as every 3-5 seconds, not rapid-fire polling.
- Compare against the baseline plus the just-sent message.
- A reply is a newly appeared incoming row after the outbound message.
- Rows authored by the user commonly expose `Você:` in the accessibility tree;
  do not treat those as replies.
- For groups, report the sender name if WhatsApp exposes it.
- Ignore delivery/read-status-only changes.

When a new incoming message appears, return its text to the user and stop
polling unless the user explicitly asked to keep monitoring.

If no reply arrives within a reasonable foreground wait (roughly 1-2 minutes),
say that there is no new reply yet. Do not block indefinitely.

For long waits, use an automation only if the user explicitly wants ongoing
monitoring beyond the current interaction and an appropriate browser-backed
monitoring path exists.

## Connection recovery

RDC may reset a stale `chrome-devtools-mcp` child automatically.

If a Chrome tool fails:

1. call `chrome_list_pages` again once,
2. re-resolve the WhatsApp page ID,
3. take a fresh snapshot,
4. continue only after confirming the intended chat.

If the error is:

`MCP server is not initialized`

do not blindly repeat a send. Re-establish the Desktop Commander/RDC MCP
connection first, then inspect the chat to see whether the outbound message was
already sent.

If `DevToolsActivePort` / Chrome remote debugging is unavailable, tell the user
the Chrome MCP connection is unavailable rather than guessing.

## Minimal execution pattern

For a request such as:

"manda 'cheguei' no grupo Notas e espera resposta"

the intended sequence is:

```text
chrome_list_pages
  -> locate WhatsApp page

chrome_take_snapshot
  -> locate "Notas"

chrome_click("Notas")
chrome_take_snapshot
  -> verify header == "Notas"
  -> locate composer
  -> capture recent-message baseline

[confirm exact destination + exact text if not already confirmed]

chrome_click(composer)
chrome_type_text(text="cheguei", submitKey="Enter")

chrome_evaluate_script
  -> verify "cheguei" is in recent rows
  -> verify composer empty

poll recent rows every few seconds
  -> first new incoming row = reply

report:
"Enviado para Notas. Resposta: ..."
```

## Response style

Keep chat responses concise.

On success:

`Enviado para **Notas**. Resposta: "..." `

If sent but still waiting:

`Enviado para **Notas**. Ainda não chegou resposta.`

On failure before send:

`Não enviei: <cause>.`

On uncertain state after a connection failure:

`A conexão caiu depois da tentativa. Vou verificar o histórico antes de tentar
de novo para não duplicar a mensagem.`

Never claim a send or a reply that was not verified in WhatsApp Web.
