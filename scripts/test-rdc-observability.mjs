import assert from 'node:assert/strict';
import { detectSsh } from '../dist/observability/ssh-detector.js';
import { redact } from '../dist/observability/redactor.js';
import { registerSshSession, getSshSession, closeSshSession } from '../dist/observability/session-tracker.js';

const ssh = detectSsh('ssh -p 2222 root@example.internal');
assert.equal(ssh?.user, 'root');
assert.equal(ssh?.host, 'example.internal');
assert.equal(ssh?.port, 2222);

const redacted = redact({
  api_key: 'sk-secret123456',
  nested: { password: 'abc', command: 'curl -H "Authorization: Bearer abcdefgh" https://example.test' }
});
assert.equal(redacted.api_key, '[REDACTED]');
assert.equal(redacted.nested.password, '[REDACTED]');
assert.match(redacted.nested.command, /\[REDACTED\]/);

const session = registerSshSession('ssh root@example.internal', {
  content: [{ type: 'text', text: 'Process started with PID 43210' }]
});
assert.ok(session);
assert.equal(session.pid, 43210);
assert.equal(getSshSession(43210)?.ssh.host, 'example.internal');
assert.equal(closeSshSession(43210)?.id, session.id);
assert.equal(getSshSession(43210), undefined);

console.log('observability tests: OK');
