import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';
import { ClaudeReplySockets } from '../hosts/claude/claude-reply-sockets.js';
import { processIdentity } from '../process/process.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { delay } from '../shared/time.js';
import type { Endpoint, Message, Peer } from '../types.js';
import { temporary } from './support/temporary.js';

const posix = { skip: process.platform === 'win32', timeout: 7000 };

function fixture(t: TestContext) {
  const directory = path.join(temporary(t), 'ipc');
  mkdirSync(directory, { mode: 0o700 });
  const events = new EventEmitter();
  const replies = new ClaudeReplySockets(receipt => events.emit('receipt', receipt));
  t.after(() => replies.close());
  return {
    directory, replies,
    async connect(address: string) {
      const socket = net.connect(address);
      socket.on('error', () => {});
      t.after(() => socket.destroy());
      await once(socket, 'connect');
      return socket;
    },
    async receipt(socket: net.Socket, id: string) {
      const receipt = { type: 'control', action: 'peer_message_status', orig_msg_id: id, status: 'delivered' };
      const result = once(events, 'receipt', { signal: AbortSignal.timeout(2000) });
      socket.write(JSON.stringify(receipt)+'\n');
      assert.deepEqual(await result, [receipt]);
    },
  };
}

test('并发发送复用同一回执地址，清理后新旧连接均可交付回执', posix, async t => {
  const f = fixture(t);
  const open = () => Promise.all(Array.from({ length: 8 }, () => f.replies.address(f.directory)));
  const addresses = await open();
  const address = addresses[0]!;
  assert.ok(addresses.every(value => value === address));
  assert.equal(path.dirname(address), f.directory);
  assert.equal(lstatSync(address).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(f.directory), [path.basename(address)]);

  const previous = await f.connect(address);
  await f.receipt(previous, '原连接');
  unlinkSync(address);
  assert.deepEqual(await open(), addresses);
  assert.equal(lstatSync(address).mode & 0o777, 0o600);
  await f.receipt(previous, '原连接仍可回执');
  previous.end();
  await once(previous, 'close');
  const restored = await f.connect(address);
  await f.receipt(restored, '原地址的新连接');
  const disconnected = once(restored, 'close');
  f.replies.close();
  await disconnected;
  assert.equal(existsSync(address), false);
});

test('原生目录被清理时不重建目录，目录由宿主恢复后主动重绑旧地址', posix, async t => {
  const f = fixture(t);
  const address = await f.replies.address(f.directory);
  unlinkSync(address);
  rmdirSync(f.directory);
  await assert.rejects(f.replies.address(f.directory), { code: 'reply_socket_unavailable' });
  assert.equal(existsSync(f.directory), false);
  mkdirSync(f.directory, { mode: 0o700 });

  const deadline = Date.now() + 3000;
  while (!existsSync(address) && Date.now() < deadline) await delay(20);
  const socket = await f.connect(address);
  await f.receipt(socket, '无后续发送的回执');
});

test('同一地址被后继 Unix socket 占用时拒绝发送，关闭时保留后继监听', posix, async t => {
  const f = fixture(t);
  const address = await f.replies.address(f.directory);
  unlinkSync(address);
  const replacement = net.createServer(socket => socket.end('后继监听'));
  replacement.listen(address);
  await once(replacement, 'listening');
  t.after(() => replacement.close());
  const inode = lstatSync(address).ino;

  await assert.rejects(f.replies.address(f.directory), { code: 'reply_socket_conflict', uncertain: false });
  f.replies.close();
  assert.equal(lstatSync(address).ino, inode);
  const socket = net.connect(address);
  t.after(() => socket.destroy());
  const [body] = await once(socket, 'data');
  assert.equal(body.toString('utf8'), '后继监听');
});

test('关闭期间的异步重绑退出，所有并发发送均保留在提交前', posix, async t => {
  const f = fixture(t);
  const address = await f.replies.address(f.directory);
  unlinkSync(address);
  const opening = [f.replies.address(f.directory), f.replies.address(f.directory)];
  f.replies.close();
  await Promise.all(opening.map(work => assert.rejects(work, { code: 'reply_socket_closed', uncertain: false })));
  await assert.rejects(f.replies.address(f.directory), { code: 'reply_socket_closed', uncertain: false });
  assert.deepEqual(readdirSync(f.directory), []);
});

test('Claude 投递编码沿用原回执地址，地址冲突在连接原生 inbox 前报告', posix, async t => {
  const home = temporary(t), inboxAddress = path.join(home, 'inbox.sock'), sessions = path.join(home, 'sessions');
  mkdirSync(sessions);
  const now = Date.now(), native = await processIdentity(process.pid);
  const peer: Peer = { id: 'member', host: 'claude', sessionId: 'session', cwd: home, name: 'Claude', owner: 'user', state: 'ready', permission: 'prompting', kind: 'root', parentId: null, updatedAt: now };
  const endpoint: Endpoint = { mode: 'claude-inbox', address: inboxAddress, configHome: home, epoch: 'epoch', peerId: peer.id, pid: native.pid, procStart: native.startedAt, active: true, seenAt: now };
  const message: Message = { id: 'message', pairId: 'pair', from: peer.id, to: peer.id, body: '测试投递', inReplyTo: null, via: null, callId: 'call', state: 'accepted', createdAt: now, updatedAt: now, evidence: null, error: null, attempts: 0 };
  writeFileSync(path.join(sessions, `${native.pid}.json`), JSON.stringify({ sessionId: peer.sessionId, cwd: home, procStart: native.startedAt }), 'utf8');

  const incoming = new EventEmitter(), adapter = new ClaudeAdapter(DEFAULT_CONFIG, home);
  let connections = 0;
  const inbox = net.createServer(socket => {
    connections++;
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      data += chunk;
      if (data.endsWith('\n')) incoming.emit('payload', JSON.parse(data));
    });
  });
  inbox.listen(inboxAddress);
  await once(inbox, 'listening');
  t.after(() => { adapter.close(); inbox.close(); });
  async function send() {
    const [[payload], result] = await Promise.all([once(incoming, 'payload', { signal: AbortSignal.timeout(2000) }), adapter.deliver(peer, endpoint, message, peer)]);
    assert.equal(result.state, 'unknown');
    assert.match(payload.from, /^uds:/);
    return decodeURIComponent(payload.from.slice(4));
  }

  const original = await send();
  assert.equal(path.dirname(original), home);
  unlinkSync(original);
  assert.equal(await send(), original);
  unlinkSync(original);
  writeFileSync(original, '后继文件', 'utf8');
  await assert.rejects(adapter.deliver(peer, endpoint, message, peer), { code: 'reply_socket_conflict', phase: 'enqueue', uncertain: false });
  assert.equal(connections, 2);
  adapter.close();
  assert.equal(readFileSync(original, 'utf8'), '后继文件');
});
