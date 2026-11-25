import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';
import { resolveCli, runCli } from '../process/host-command.js';
import { overrideEnvironment } from '../tests/support/environment.js';
import { temporaryDirectory } from '../tests/support/temporary.js';
import type { Peer } from '../types.js';

test('官方 Claude 恢复原会话 ID 并公布新建的持久收件 socket', { skip: process.platform === 'win32', timeout: 60000 }, async t => {
  const fixture = temporaryDirectory('/tmp'), root = fixture.directory;
  const home = path.join(root, 'bridge'), configHome = path.join(root, 'claude'), userHome = path.join(root, 'user');
  const tempHome = path.join(root, 'tmp'), runtimeHome = path.join(root, 'runtime');
  for (const directory of [home, configHome, userHome, tempHome, runtimeHome]) mkdirSync(directory, { mode: 0o700 });
  const executable = resolveCli('claude'), sessionId = randomUUID();
  const config = { ...DEFAULT_CONFIG, claudeHome: configHome, claudeCommand: [executable.command, ...executable.prefix] };
  const adapter = new ClaudeAdapter(config, home);
  const peer: Peer = { id: randomUUID(), host: 'claude', sessionId, cwd: root, name: 'Claude', owner: 'nxbridge', state: 'offline', permission: 'prompting', kind: 'root', parentId: null, updatedAt: Date.now() };

  const response = { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 2, output_tokens: 1 } };
  const model = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (!req.url?.includes('/v1/messages') || req.url.includes('count_tokens')) {
      res.setHeader('content-type', 'application/json').end('{"input_tokens":2}');
    } else if (JSON.parse(raw).stream) {
      res.setHeader('content-type', 'text/event-stream');
      for (const event of [
        { type: 'message_start', message: response },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'INBOX_PERSISTENCE_PROOF' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } else {
      res.setHeader('content-type', 'application/json').end(JSON.stringify({ ...response, content: [{ type: 'text', text: 'INBOX_PERSISTENCE_PROOF' }], stop_reason: 'end_turn', stop_sequence: null }));
    }
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const key = 'nxbridge-persistent-inbox-loopback-only';
  const restore = overrideEnvironment({ HOME: userHome, TMPDIR: tempHome, XDG_RUNTIME_DIR: runtimeHome,
    XDG_CACHE_HOME: path.join(userHome, '.cache'), XDG_CONFIG_HOME: path.join(userHome, '.config'),
    XDG_DATA_HOME: path.join(userHome, '.local', 'share'), XDG_STATE_HOME: path.join(userHome, '.local', 'state'),
    NXBRIDGE_HOME: home, CLAUDE_CONFIG_DIR: configHome, ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}`, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  t.after(async () => {
    try { adapter.close(); await fixture.cleanup(); }
    finally { model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); restore(); }
  });
  const projects = Object.fromEntries([root, realpathSync(root)].map(directory => [directory, { hasTrustDialogAccepted: true }]));
  writeFileSync(path.join(configHome, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, hasTrustDialogAccepted: true, customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] }, projects }), 'utf8');

  const output = await runCli('claude', ['--print', '--model', response.model, '--session-id', sessionId, '初始化套接字验收'], { cwd: root, config, home, timeout: 15000 });
  assert.match(output, /INBOX_PERSISTENCE_PROOF/);
  await adapter.wake(peer);
  const restored = await adapter.discover(sessionId);
  assert.equal(restored?.sessionId, sessionId);
  const address = restored.endpoint.address;
  assert.match(path.basename(address), /^ci-[a-f0-9]{16}\.sock$/);
  assert.equal(realpathSync(path.dirname(address)), realpathSync(path.join(home, 'run')));
  assert.ok(lstatSync(address).isSocket());
  await adapter.release(peer);
});
