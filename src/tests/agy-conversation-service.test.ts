import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  AgyConversationTracker,
  extractAgyLsConnection,
  getAgyConversation,
  parseLocalAgyLsAddress,
  syncAgyConversationPairedTag,
} from '../hosts/agy/conversation-service.js';

test('parseLocalAgyLsAddress 仅允许本机环回地址与合法端口，拒绝外部主机和路径注入', () => {
  assert.equal(parseLocalAgyLsAddress('localhost:46459'), 'localhost:46459');
  assert.equal(parseLocalAgyLsAddress('127.0.0.1:8080'), '127.0.0.1:8080');
  assert.equal(parseLocalAgyLsAddress('[::1]:9000'), '[::1]:9000');
  for (const invalid of [
    '',
    'localhost:0',
    'localhost:70000',
    '192.168.1.10:8080',
    'example.com:443',
    'http://localhost:8080',
    'localhost:8080/evil',
    null,
    undefined,
  ]) {
    assert.equal(parseLocalAgyLsAddress(invalid), undefined);
  }
  assert.deepEqual(
    extractAgyLsConnection({ ANTIGRAVITY_LS_ADDRESS: 'localhost:46459', ANTIGRAVITY_CSRF_TOKEN: 'tok-1' }),
    { address: 'localhost:46459', csrfToken: 'tok-1' },
  );
  assert.equal(
    extractAgyLsConnection({ ANTIGRAVITY_LS_ADDRESS: 'remote.host:46459', ANTIGRAVITY_CSRF_TOKEN: 'tok-1' }),
    undefined,
  );
});

test('syncAgyConversationPairedTag 幂等增删标签、保留用户原有标签，且在服务异常或超时时静默降级', async t => {
  const tagsByConv = new Map<string, string[]>([['conv-1', ['user-tag']]]);
  const calls: { url: string; csrf: string | undefined; body: any }[] = [];
  let failMode: 'none' | 'error' | 'hang' = 'none';

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ url: req.url ?? '', csrf: req.headers['x-antigravity-csrf-token'] as string | undefined, body });
    if (failMode === 'error') {
      res.writeHead(503).end('unavailable');
      return;
    }
    if (failMode === 'hang') {
      setTimeout(() => res.writeHead(200).end('{}'), 400);
      return;
    }
    if (req.url === '/product.v1.ConversationService/GetConversation') {
      const id = String(body.conversationId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, annotations: { title: 'Demo', tags: tagsByConv.get(id) ?? [] } }));
      return;
    }
    if (req.url === '/product.v1.ConversationService/UpdateConversation') {
      const id = String(body.conversationId);
      const next = Array.isArray(body.annotations?.tags) ? body.annotations.tags : [];
      tagsByConv.set(id, next);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, annotations: { title: 'Demo', tags: next } }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const addr = server.address() as { port: number };
  const conn = { address: `127.0.0.1:${addr.port}`, csrfToken: 'secret-csrf' };

  const fetched = await getAgyConversation(conn, 'conv-1');
  assert.deepEqual(fetched?.annotations?.tags, ['user-tag']);

  // Add paired tag while preserving user-tag
  assert.equal(await syncAgyConversationPairedTag(conn, 'conv-1', true), true);
  assert.deepEqual(tagsByConv.get('conv-1'), ['user-tag', 'agybridge:paired']);
  const countAfterFirstAdd = calls.length;

  // Idempotent second add makes no UpdateConversation write
  assert.equal(await syncAgyConversationPairedTag(conn, 'conv-1', true), true);
  assert.equal(calls.length, countAfterFirstAdd + 1);

  // Remove paired tag via tracker while preserving user-tag
  const tracker = new AgyConversationTracker();
  tracker.observe({ pid: 1234, procStart: 'gen-1', sessionId: 'conv-1', ls: conn });
  assert.equal(await tracker.syncPairedBestEffort({ pid: 1234, procStart: 'gen-1', sessionId: 'conv-1' }, false), true);
  assert.deepEqual(tagsByConv.get('conv-1'), ['user-tag']);
  assert.ok(calls.every(c => c.csrf === 'secret-csrf'));

  // Best-effort non-throwing degradation on 503 and timeout
  failMode = 'error';
  assert.equal(await tracker.syncPairedBestEffort({ sessionId: 'conv-1' }, true), false);
  failMode = 'hang';
  assert.equal(await tracker.syncPairedBestEffort({ sessionId: 'conv-1' }, true, { timeoutMs: 80 }), false);
});

test('Broker 持久化 AGY ACP 动态 mode 更新，并在配对与解配时异步同步 ConversationService 标签', async t => {
  const { fixture } = await import('./support/broker-fixture.js');
  const f = fixture(t);
  const tags = new Map<string, string[]>([['c', ['existing']]]);
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/product.v1.ConversationService/GetConversation') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: body.conversationId, annotations: { tags: tags.get(body.conversationId) ?? [] } }));
      return;
    }
    if (req.url === '/product.v1.ConversationService/UpdateConversation') {
      tags.set(body.conversationId, body.annotations?.tags ?? []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: body.conversationId, annotations: { tags: tags.get(body.conversationId) } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;

  const ep = f.store.endpoint(f.a.id)!;
  f.broker.agyConversations.observe({ pid: ep.pid, procStart: ep.procStart, sessionId: 'c', ls: { address: `127.0.0.1:${port}`, csrfToken: 't-csrf' } });

  const pair = f.store.pair(f.a.id, f.x.id);
  for (let i = 0; i < 30 && !tags.get('c')?.includes('agybridge:paired'); i++) {
    await new Promise(r => setTimeout(r, 20));
  }
  assert.deepEqual(tags.get('c'), ['existing', 'agybridge:paired']);

  // Dynamic ACP permission/mode event updates active agy-acp endpoint
  f.store.saveEndpoint({ ...ep, mode: 'agy-acp' });
  f.agy.emit('permission', 'c', 'prompting', 'accept-edits');
  for (let i = 0; i < 20 && f.store.endpoint(f.a.id)?.nativePermission?.mode !== 'accept-edits'; i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(f.store.peer(f.a.id).permission, 'prompting');
  assert.equal(f.store.endpoint(f.a.id)?.nativePermission?.mode, 'accept-edits');

  f.store.unpair(pair.id);
  for (let i = 0; i < 30 && tags.get('c')?.includes('agybridge:paired'); i++) {
    await new Promise(r => setTimeout(r, 20));
  }
  assert.deepEqual(tags.get('c'), ['existing']);

  // Multiple active endpoints (ambiguous_endpoint) must never break store.pair
  f.store.saveEndpoint({ ...ep, epoch: 'dup-1', mode: 'agy-acp', active: true });
  f.store.saveEndpoint({ ...ep, epoch: 'dup-2', mode: 'agy-acp', active: true });
  assert.doesNotThrow(() => f.store.pair(f.a.id, f.x.id, true));
});
