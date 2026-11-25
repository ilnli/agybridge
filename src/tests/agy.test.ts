import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { AcpClient } from '../hosts/agy/acp-client.js';
import { fixture } from './support/broker-fixture.js';
import { temporaryDirectory } from './support/temporary.js';
import { agyMcpIdentity, agyHookRegistration, agyTranscriptPath } from '../hosts/agy/identity.js';
import { AgyAdapter } from '../hosts/agy/adapter.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import type { Peer } from '../types.js';

const FAKE_ACP_SCRIPT = `
import { createInterface } from 'node:readline';

let seq = 0;
let currentModel = 'gemini-3.1-pro';
let currentEffort = 'medium';
let lastSessionId = 'acp-session-1';
let resumedId = null;
const pendingPermissions = new Map();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const fn = pendingPermissions.get(msg.id);
    if (fn) {
      pendingPermissions.delete(msg.id);
      fn(msg.result);
    }
    return;
  }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, serverInfo: { name: 'fake-agy', version: '1.0.0' } } });
    return;
  }
  if (method === 'session/new') {
    if (!Array.isArray(params?.mcpServers) || !params.mcpServers.some(s => s?.name === 'codex' && Array.isArray(s?.args) && s.args.includes('mcp') && s.args.includes('agy'))) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'missing codex mcpServer in session/new' } });
      return;
    }
    lastSessionId = 'acp-session-1';
    send({
      jsonrpc: '2.0',
      id,
      result: {
        sessionId: lastSessionId,
        configOptions: [
          { id: 'model', category: 'model', currentValue: currentModel },
          { id: 'thought_level', category: 'thought_level', currentValue: currentEffort },
        ],
      },
    });
    return;
  }
  if (method === 'session/resume') {
    if (!Array.isArray(params?.mcpServers) || !params.mcpServers.some(s => s?.name === 'codex')) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'missing codex mcpServer in session/resume' } });
      return;
    }
    resumedId = params.sessionId;
    lastSessionId = params.sessionId;
    send({
      jsonrpc: '2.0',
      id,
      result: {
        sessionId: lastSessionId,
        configOptions: [
          { id: 'model', category: 'model', currentValue: currentModel },
          { id: 'thought_level', category: 'thought_level', currentValue: currentEffort },
        ],
      },
    });
    return;
  }
  if (method === 'session/set_config_option') {
    if (params.configId === 'model') currentModel = params.value;
    if (params.configId === 'thought_level') currentEffort = params.value;
    const configOptions = [
      { id: 'model', category: 'model', currentValue: currentModel },
      { id: 'thought_level', category: 'thought_level', currentValue: currentEffort },
    ];
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'config_option_update', configOptions } } });
    send({ jsonrpc: '2.0', id, result: { configOptions } });
    return;
  }
  if (method === 'session/prompt') {
    const promptText = params?.prompt?.[0]?.text ?? '';
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'mcp_agybridge_codex_send_message' } } });
    const reqId = ++seq;
    pendingPermissions.set(reqId, result => {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'usage_update', used: 4200, size: 100000 } } });
      send({
        jsonrpc: '2.0',
        id,
        result: {
          stopReason: result?.outcome?.optionId === 'allow-once' ? 'end_turn' : 'cancelled',
          echo: promptText,
          resumedId,
        },
      });
    });
    send({
      jsonrpc: '2.0',
      id: reqId,
      method: 'session/request_permission',
      params: {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'codex.send_message' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      },
    });
    return;
  }
  if (method === 'session/close') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
`;

test('ACP 输出通道关闭时，未完成的轮次结束等待并回收子进程',async t=>{
  const child=spawn(process.execPath,['-e',"process.stdin.once('data',()=>process.stdout.end());setInterval(()=>{},1000)"],{stdio:'pipe'});
  const closed=once(child,'close'),client=new AcpClient(child);
  t.after(async()=>{child.kill();await closed;});
  await assert.rejects(client.prompt('acp-session','hello'),{code:'acp_exited',uncertain:true});
  await closed;
  assert.equal(client.isClosed,true);
});

test('agyMcpIdentity 与 agyHookRegistration 准确解析根会话、子代理及产物路径', () => {
  const root = agyMcpIdentity(
    {
      'antigravity.google/conversation_id': 'conv-root',
      'antigravity.google/root_conversation_id': 'conv-root',
      'antigravity.google/artifacts_dir': '/tmp/brain/conv-root',
    },
    '/workspace',
    { pid: 4321, procStart: 'start-1', acp: false },
    '/home/u/.gemini',
  );
  assert.equal(root.actor.host, 'agy');
  assert.equal(root.actor.sessionId, 'conv-root');
  assert.equal(root.actor.via, undefined);
  assert.equal(root.registration.kind, 'root');
  assert.equal(root.registration.endpoint.mode, 'agy-tui');
  assert.equal(root.registration.endpoint.processKind, 'foreground');
  assert.equal(root.registration.endpoint.nativeSession?.artifactsDir, '/tmp/brain/conv-root');
  assert.equal(root.registration.endpoint.nativeSession?.transcriptPath, path.join('/tmp/brain/conv-root', '.system_generated', 'logs', 'transcript_full.jsonl'));

  const sub = agyMcpIdentity(
    {
      'antigravity.google/conversation_id': 'conv-sub',
      'antigravity.google/root_conversation_id': 'conv-root',
    },
    '/workspace',
    { pid: 4321, procStart: 'start-1', acp: true },
    '/home/u/.gemini',
  );
  assert.equal(sub.actor.via, 'conv-sub');
  assert.equal(sub.registration.kind, 'subagent');
  assert.equal(sub.registration.parentId, 'conv-root');
  assert.equal(sub.registration.endpoint.mode, 'agy-acp');
  assert.equal(sub.registration.endpoint.processKind, 'app-server');
  assert.equal(sub.registration.endpoint.nativeSession?.transcriptPath, agyTranscriptPath('/home/u/.gemini', 'conv-sub'));

  const hookReg = agyHookRegistration(
    {
      conversationId: 'conv-hook',
      workspacePaths: ['/proj/a', '/proj/b'],
      artifactDirectoryPath: '/tmp/brain/conv-hook',
      modelName: 'gemini-3.1-pro',
    },
    { pid: 9999, procStart: 'start-hook' },
    '/home/u/.gemini',
  );
  assert.equal(hookReg.sessionId, 'conv-hook');
  assert.equal(hookReg.cwd, '/proj/a');
  assert.equal(hookReg.model, 'gemini-3.1-pro');
  assert.equal(hookReg.endpoint.mode, 'agy-tui');
  assert.equal(hookReg.endpoint.nativeSession?.artifactsDir, '/tmp/brain/conv-hook');
  const resumedHookReg = agyHookRegistration(
    {
      conversationId: 'conv-hook',
      workspacePaths: ['/proj/old', '/proj/new'],
      cwd: '/proj/old',
    },
    { pid: 9999, procStart: 'start-hook', cwd: '/proj/new' },
    '/home/u/.gemini',
  );
  assert.equal(resumedHookReg.cwd, '/proj/new');
  assert.throws(() => agyHookRegistration({}, { pid: 1, procStart: 's' }), { code: 'unverified_identity' });
});

test('AGY MCP cwdFallback 不覆盖已登记的工作区 cwd', async t => {
  const f = fixture(t);
  const first = f.store.register({
    host: 'agy',
    sessionId: 'conv-cwd-guard',
    cwd: '/workspace/real-project',
    name: 'AGY',
    kind: 'root',
    endpoint: { mode: 'agy-tui', address: '', epoch: 'agy-tui:5000:s1:conv-cwd-guard', pid: 5000, procStart: 's1', configHome: '/home/u/.gemini', processKind: 'foreground' },
  });
  assert.equal(first.cwd, '/workspace/real-project');
  const second = f.store.register({
    host: 'agy',
    sessionId: 'conv-cwd-guard',
    cwd: '/home/u/.gemini/config/plugins/agybridge',
    cwdFallback: true,
    name: 'AGY',
    kind: 'root',
    endpoint: { mode: 'agy-tui', address: '', epoch: 'agy-tui:5000:s1:conv-cwd-guard', pid: 5000, procStart: 's1', configHome: '/home/u/.gemini', processKind: 'foreground' },
  });
  assert.equal(second.id, first.id);
  assert.equal(second.cwd, '/workspace/real-project');
});

test('agy.wait 支持立即取信、挂起异步唤醒、重复监听替换和取消', async t => {
  const f = fixture(t);
  const pair = f.store.pair(f.a.id, f.x.id);
  f.store.saveEndpoint({ ...f.store.endpoint(f.a.id)!, mode: 'agy-tui' });
  const agyActor = { host: 'agy' as const, sessionId: 'c', callId: 'wait-1' };
  const codexActor = { host: 'codex' as const, sessionId: 'x', callId: 'send-1' };

  // 1. Immediate drain of pending message -> contextObserved immediately
  const firstMsg = f.store.accept(pair, f.x, '提前发来的回复', 'pre-1');
  const immediate = await f.broker.dispatch('agy.wait', { actor: agyActor }) as any;
  assert.equal(immediate.status, 'received');
  assert.equal(immediate.messages.length, 1);
  assert.equal(immediate.messages[0].message_id, firstMsg.id);
  assert.equal(immediate.messages[0].message, '提前发来的回复');
  assert.equal(f.store.message(firstMsg.id).state, 'contextObserved');

  // 2. Parked async waiter woken by Codex send
  const parked = f.broker.dispatch('agy.wait', { actor: { ...agyActor, callId: 'wait-2' }, timeout_ms: 5000 });
  await new Promise(r => setImmediate(r));
  assert.equal(f.broker.hasAgyWaiter(f.a.id), true);
  const sent = await f.broker.dispatch('send', { actor: codexActor, message: '异步唤醒测试消息' }) as any;
  const woken = await parked as any;
  assert.equal(woken.status, 'received');
  assert.equal(woken.messages.length, 1);
  assert.equal(woken.messages[0].message_id, sent.message_id);
  assert.equal(woken.messages[0].message, '异步唤醒测试消息');
  assert.equal(f.store.message(sent.message_id).state, 'contextObserved');
  assert.match(f.store.message(sent.message_id).evidence ?? '', /wait_partner/);
  assert.equal(f.broker.hasAgyWaiter(f.a.id), false);

  // 3. Waiter replacement deduplication
  const firstWait = f.broker.dispatch('agy.wait', { actor: { ...agyActor, callId: 'wait-3a' }, timeout_ms: 5000 });
  await new Promise(r => setImmediate(r));
  const secondWait = f.broker.dispatch('agy.wait', { actor: { ...agyActor, callId: 'wait-3b' }, timeout_ms: 5000 });
  await new Promise(r => setImmediate(r));
  const replaced = await firstWait as any;
  assert.equal(replaced.status, 'replaced');
  assert.equal(f.broker.hasAgyWaiter(f.a.id), true);

  // 4. Cancellation when member is paused via Stop USER_CANCELED
  await f.broker.dispatch('hook', { host: 'agy', conversationId: 'c', hookEventName: 'Stop', terminationReason: 'USER_CANCELED' });
  const cancelled = await secondWait as any;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.reason, 'user_canceled');
  assert.equal(f.store.peer(f.a.id).state, 'paused');
  assert.equal(f.store.peer(f.a.id).pauseReason, 'interrupted');

  // 5. ACP mode returns automatic
  f.store.updatePeer(f.a.id, { state: 'ready', pauseReason: undefined });
  f.store.saveEndpoint({ ...f.store.endpoint(f.a.id)!, mode: 'agy-acp' });
  const acpWait = await f.broker.dispatch('agy.wait', { actor: { ...agyActor, callId: 'wait-acp' } }) as any;
  assert.equal(acpWait.status, 'automatic');
});

test('AGY hooks 覆盖 allow、普通子代理放行、nxref 改写、PostToolUse 空返回、recentWake 防重复拦截和 Stop 兜底', async t => {
  const f = fixture(t);
  const pair = f.store.pair(f.a.id, f.x.id);
  f.store.saveEndpoint({ ...f.store.endpoint(f.a.id)!, mode: 'agy-tui' });

  // PreToolUse allow for codex MCP tools (both plugin and ACP prefixes) and normal invoke_subagent
  const approved = await f.broker.dispatch('hook', {
    host: 'agy',
    conversationId: 'c',
    hookEventName: 'PreToolUse',
    toolCall: { id: 't1', name: 'mcp_agybridge_codex_send_message', args: { message: 'hi' } },
  }) as any;
  assert.deepEqual(approved, { decision: 'allow' });
  const approvedAcp = await f.broker.dispatch('hook', {
    host: 'agy',
    conversationId: 'c',
    hookEventName: 'PreToolUse',
    toolCall: { id: 't1b', name: 'mcp_codex_send_message', args: { message: 'hi' } },
  }) as any;
  assert.deepEqual(approvedAcp, { decision: 'allow' });
  const plainSubagent = await f.broker.dispatch('hook', {
    host: 'agy',
    conversationId: 'c',
    hookEventName: 'PreToolUse',
    toolCall: { id: 't1c', name: 'invoke_subagent', args: { Prompt: '普通子代理任务，不含引用' } },
  }) as any;
  assert.deepEqual(plainSubagent, { decision: 'allow' });

  // PostToolUse returns {}
  const post = await f.broker.dispatch('hook', {
    host: 'agy',
    conversationId: 'c',
    hookEventName: 'PostToolUse',
    toolCall: { id: 't1', name: 'mcp_agybridge_codex_send_message' },
  });
  assert.deepEqual(post, {});

  // PreToolUse invoke_subagent expands nxref and denies unknown refs
  f.broker.references.capture(f.a, 'agent-1', '请参考 /workspace/src/app.ts:42 实现。');
  const expanded = await f.broker.dispatch('hook', {
    host: 'agy',
    conversationId: 'c',
    hookEventName: 'PreToolUse',
    toolCall: { id: 't2', name: 'invoke_subagent', args: { Prompt: '检查 nxref:agent:agent-1' } },
  }) as any;
  assert.equal(expanded.decision, 'allow');
  assert.match(expanded.overwrite.Prompt, /\/workspace\/src\/app\.ts:42/);
  const denied = await f.broker.dispatch('hook', {
    host: 'agy',
    conversationId: 'c',
    hookEventName: 'PreToolUse',
    toolCall: { id: 't3', name: 'invoke_subagent', args: { Prompt: '检查 nxref:agent:nonexistent123' } },
  }) as any;
  assert.equal(denied.decision, 'deny');

  // PreInvocation agybridge pair injects picker instruction
  const pairPrompt = await f.broker.dispatch('hook', {
    host: 'agy',
    conversationId: 'c',
    hookEventName: 'PreInvocation',
    lastUserInput: 'agybridge pair',
  }) as any;
  assert.ok(Array.isArray(pairPrompt.injectSteps));
  assert.match(pairPrompt.injectSteps[0].systemMessage.systemMessage, /choose_partner/);

  // PreInvocation agybridge pair <code> returns visible systemMessage without terminationBehavior:'terminate'
  const pairCodePrompt = await f.broker.dispatch('hook', {
    host: 'agy',
    conversationId: 'c',
    hookEventName: 'PreInvocation',
    lastUserInput: 'agybridge pair 9999',
  }) as any;
  assert.ok(Array.isArray(pairCodePrompt.injectSteps));
  assert.equal(pairCodePrompt.terminationBehavior, undefined);
  assert.match(pairCodePrompt.injectSteps[0].systemMessage.systemMessage, /agybridge 控制命令已由 hook 执行完成/);

  // recentWake suppresses repeated PreInvocation control command on wait_partner turn 2
  const pendingMsg = f.store.accept(pair, f.x, '来自 Codex 的回复', 'wake-check');
  await f.broker.dispatch('agy.wait', { actor: { host: 'agy', sessionId: 'c', callId: 'wake-guard' } });
  assert.equal(f.store.message(pendingMsg.id).state, 'contextObserved');
  const suppressed = await f.broker.dispatch('hook', {
    host: 'agy',
    conversationId: 'c',
    hookEventName: 'PreInvocation',
    lastUserInput: 'agybridge pair',
  }) as any;
  assert.deepEqual(suppressed, {});

  // Stop fallback returns decision:'continue' when pending messages exist and no wait_partner is armed
  f.store.accept(pair, f.x, 'Stop 兜底未读消息', 'stop-fallback');
  const stopFallback = await f.broker.dispatch('hook', {
    host: 'agy',
    conversationId: 'c',
    hookEventName: 'Stop',
  }) as any;
  assert.equal(stopFallback.decision, 'continue');
  assert.match(stopFallback.reason, /receive_messages/);

  // Stop returns {} when continuationActive is true
  const stopNoLoop = await f.broker.dispatch('hook', {
    host: 'agy',
    conversationId: 'c',
    hookEventName: 'Stop',
    continuationActive: true,
  });
  assert.deepEqual(stopNoLoop, {});
});

test('AgyAdapter 通过 stdio ACP 完成 create、deliver、usage/profile、setProfile、handoff 与 wake/resume', async t => {
  const temp = temporaryDirectory();
  const home = path.join(temp.directory, 'bridge');
  const script = path.join(temp.directory, 'fake-acp.mjs');
  writeFileSync(script, FAKE_ACP_SCRIPT, 'utf8');

  const config = {
    ...DEFAULT_CONFIG,
    agyCommand: [process.execPath, script],
    agyHome: path.join(temp.directory, 'gemini'),
  };
  const adapter = new AgyAdapter(config, home);
  const peer: Peer = {
    id: 'peer-agy-acp-test',
    host: 'agy',
    sessionId: null,
    cwd: temp.directory,
    name: 'AGY',
    kind: 'root',
    parentId: null,
    owner: 'nxbridge',
    permission: 'bypass',
    state: 'starting',
    updatedAt: Date.now(),
    enabled: true,
  };
  const sender: Peer = { ...peer, id: 'peer-codex-sender', host: 'codex', name: 'Codex' };

  t.after(async () => {
    await adapter.release(peer);
    adapter.close();
    await temp.cleanup();
  });

  // 1. create() initializes ACP, creates session, applies initial profile
  const reg = await adapter.create(peer, undefined, 'bypass', undefined, { model: 'gemini-3.1-pro-custom', effort: 'high' });
  assert.equal(reg.host, 'agy');
  assert.equal(reg.sessionId, 'acp-session-1');
  assert.equal(reg.model, 'gemini-3.1-pro-custom');
  assert.equal(reg.effort, 'high');
  assert.equal(reg.endpoint.mode, 'agy-acp');
  assert.ok(reg.endpoint.pid && reg.endpoint.procStart);

  const activePeer: Peer = { ...peer, sessionId: reg.sessionId, state: 'ready', model: reg.model, effort: reg.effort };
  const endpoint = { ...reg.endpoint, peerId: activePeer.id, active: true, seenAt: Date.now() };

  // 2. probe() reports reachable
  const avail = await adapter.probe(activePeer, endpoint);
  assert.equal(avail.state, 'reachable');
  assert.equal(avail.nativeState, 'alive');

  // 3. deliver() submits session/prompt, auto-handles permission request, emits usage + turnCompleted
  const usagePromise = once(adapter, 'usage');
  const turnPromise = once(adapter, 'turnCompleted');
  const message = {
    id: 'msg-1',
    pairId: 'pair-1',
    from: sender.id,
    to: activePeer.id,
    body: '请帮我核查这段逻辑',
    callId: 'c1',
    state: 'sending' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    attempts: 1,
    inReplyTo: null,
    via: null,
    evidence: null,
    error: null,
    replyExpected: true,
  };
  let finishCheck!:(current:boolean)=>void;
  const delayed=adapter.deliver(activePeer,endpoint,{...message,beforeSubmit:()=>new Promise(resolve=>{finishCheck=resolve;})},sender);
  const delivered=await adapter.deliver(activePeer,endpoint,message,sender);
  finishCheck(true);
  assert.equal((await delayed).state,'expired');
  assert.equal(delivered.state, 'contextObserved');
  const [usageSid, usagePayload] = await usagePromise;
  assert.equal(usageSid, 'acp-session-1');
  assert.equal(usagePayload.tokens, 4200);
  const [completedSid] = await turnPromise;
  assert.equal(completedSid, 'acp-session-1');
  assert.equal(adapter.healthOf(activePeer.id)?.state, 'ready');

  // 4. setProfile & readProfile
  const updated = await adapter.setProfile(activePeer, endpoint, { model: 'gemini-3.1-flash', effort: 'low' });
  assert.equal(updated.model, 'gemini-3.1-flash');
  assert.equal(updated.effort, 'low');
  const readBack = await adapter.readProfile(activePeer, endpoint);
  assert.equal(readBack.model, 'gemini-3.1-flash');
  assert.equal(readBack.effort, 'low');

  // 5. handoffToForeground closes ACP process and returns sessionId
  const handoff = await adapter.handoffToForeground(activePeer);
  assert.equal(handoff.sessionId, 'acp-session-1');
  assert.equal(adapter.healthOf(activePeer.id), undefined);

  // 6. wake() respawns ACP process and resumes the same sessionId
  const resumed = await adapter.wake(activePeer, endpoint);
  assert.equal(resumed.sessionId, 'acp-session-1');
  assert.equal(resumed.endpoint.mode, 'agy-acp');
  assert.notEqual(resumed.endpoint.pid, reg.endpoint.pid);
  await assert.rejects(adapter.deliver(activePeer,endpoint,message,sender),{code:'agy_acp_offline'});
});
