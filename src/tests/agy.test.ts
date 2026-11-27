import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { AcpClient } from '../hosts/agy/acp-client.js';
import { fixture } from './support/broker-fixture.js';
import { temporary, temporaryDirectory } from './support/temporary.js';
import { agyArtifactsDir, agyMcpIdentity, agyHookRegistration, agyTranscriptPath, detectAgySubagentLineage } from '../hosts/agy/identity.js';
import { AgyAdapter } from '../hosts/agy/adapter.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { AGY_WAKE_NOTICE, type Peer, type BridgeConfig } from '../types.js';
import { hook as runHook } from '../integration/hooks/hook-control.js';
import { hookContextMatches } from '../integration/hooks/session-bindings.js';

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
  assert.equal(sub.registration.endpoint.nativeSession?.artifactsDir, path.join('/home/u/.gemini','antigravity-cli','brain','conv-sub'));
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
  assert.equal(resumedHookReg.endpoint.nativeSession?.artifactsDir, agyArtifactsDir('/home/u/.gemini','conv-hook'));
  const subHookReg = agyHookRegistration(
    { conversationId: 'conv-child', parentConversationId: 'conv-hook', agentName: 'research' },
    { pid: 9999, procStart: 'start-hook' },
    '/home/u/.gemini',
  );
  assert.equal(subHookReg.kind, 'subagent');
  assert.equal(subHookReg.parentId, 'conv-hook');
  assert.throws(() => agyHookRegistration({}, { pid: 1, procStart: 's' }), { code: 'unverified_identity' });
});

test('模型状态为 AGY 自己与搭档返回相同的产物和 scratch 目录，兼容旧登记', async t => {
  const f=fixture(t),endpoint=f.store.endpoint(f.a.id)!;
  const status=(host:'agy'|'codex')=>f.broker.dispatch('status',{
    actor:{host,sessionId:host==='agy'?'c':'x',callId:'status'},model_view:true,
  }) as Promise<any>;
  const fallback=agyArtifactsDir(endpoint.configHome!,'c');
  const unpaired=await status('agy');
  assert.equal(unpaired.self.artifacts_dir,fallback);
  assert.equal(unpaired.self.scratch_dir,path.join(fallback,'scratch'));

  const explicit=path.join(endpoint.configHome!,'custom-artifacts');
  f.store.saveEndpoint({...endpoint,nativeSession:{artifactsDir:explicit}});
  f.store.pair(f.a.id,f.x.id);
  const agy=await status('agy'),codex=await status('codex');
  for(const view of [agy.self,codex.partner]){
    assert.equal(view.artifacts_dir,explicit);
    assert.equal(view.scratch_dir,path.join(explicit,'scratch'));
  }
  for(const view of [codex.self,agy.partner]){
    assert.equal(view.artifacts_dir,undefined);
    assert.equal(view.scratch_dir,undefined);
  }
});

test('同一原生会话交替登记时保留 AGY 显式路径，新会话重新推导',async t=>{
  const {store,broker}=fixture(t);
  for(const acp of [false,true]){
    const runtime={pid:process.pid,procStart:'artifact-fixture',acp},configHome=store.endpoint(store.find('agy','c')!.id)!.configHome!;
    const conversationId='artifacts-'+(acp?'acp':'tui'),custom=path.join(configHome,'custom'),standard=agyArtifactsDir(configHome,conversationId);
    const mcp=(dir?:string)=>agyMcpIdentity({conversationId,'antigravity.google/artifacts_dir':dir},configHome,runtime,configHome).registration;
    const hook=(dir?:string,transcriptPath?:string)=>agyHookRegistration({conversationId,artifactDirectoryPath:dir,transcriptPath},runtime,configHome);
    const register=async(input:ReturnType<typeof hook>)=>{
      const peer=await broker.dispatch('mcp.register',input) as Peer;
      return store.endpoint(peer.id)!.nativeSession!;
    };
    assert.equal((await register(mcp(custom))).artifactsDir,custom);
    const inferred=await register(hook());
    assert.equal(inferred.artifactsDir,custom);
    assert.equal(inferred.transcriptPath,path.join(custom,'.system_generated','logs','transcript_full.jsonl'));
    const transcript=path.join(configHome,'explicit.jsonl');
    await register(hook(undefined,transcript));
    assert.equal((await register(mcp())).transcriptPath,transcript);
    if(acp){
      const stale=mcp(standard);stale.endpoint.procStart='previous-process';
      assert.equal((await register(stale)).artifactsDir,custom);
    }
    assert.equal((await register(mcp(standard))).artifactsDir,standard);
    const next=await register(agyHookRegistration({conversationId:conversationId+'-next'},runtime,configHome));
    assert.equal(next.artifactsDir,agyArtifactsDir(configHome,conversationId+'-next'));
    assert.equal(next.transcriptPath,agyTranscriptPath(configHome,conversationId+'-next'));
  }
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

  // Pair code results are rendered inline and finish the invocation.
  const pairCodePrompt = await f.broker.dispatch('hook', {
    host: 'agy',
    conversationId: 'c',
    hookEventName: 'PreInvocation',
    lastUserInput: 'agybridge pair 9999',
  }) as any;
  assert.ok(Array.isArray(pairCodePrompt.injectSteps));
  assert.equal(pairCodePrompt.terminationBehavior, 'terminate');
  assert.equal(pairCodePrompt.injectSteps[0].systemMessage.systemMessage, '');
  assert.match(pairCodePrompt.injectSteps[0].systemMessage.metadata.user_markdown, /配对码/);

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
  assert.equal(stopFallback.reason, AGY_WAKE_NOTICE);

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

function foregroundPair(t:TestContext, config:Partial<BridgeConfig>={}) {
  const f=fixture(t,config);
  const pair=f.store.pair(f.a.id,f.x.id);
  f.store.saveEndpoint({...f.store.endpoint(f.a.id)!,mode:'agy-tui'});
  const actor={host:'agy' as const,sessionId:'c',callId:'agy-call'};
  const hook=(event:string,fields:Record<string,unknown>={})=>f.broker.dispatch('hook',{
    host:'agy',conversationId:'c',hookEventName:event,...fields,
  }) as Promise<{decision?:string;reason?:string;injectSteps?:{systemMessage:{systemMessage:string}}[]}>;
  const send=(callId:string,replyExpected=true)=>f.broker.send({
    actor:{...actor,callId},message:callId,reply_expected:replyExpected,
  },false);
  return {...f,pair,actor,hook,send};
}

test('AGY 收信提示在没有 hook 的首次调用和新的原生轮次各出现一次，等待器优先收信',async t=>{
  const f=foregroundPair(t);
  const hint=()=>f.broker.dispatch('messages.pending-hint',f.actor);
  const parked=f.broker.dispatch('agy.wait',{actor:f.actor,timeout_ms:5000});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.broker.hasAgyWaiter(f.a.id),true);
  f.store.accept(f.pair,f.x,'先交给等待器','waiting');
  assert.deepEqual(await hint(),{});
  f.broker.wakeAgyWaiter(f.a.id);
  await parked;
  const unread=f.store.accept(f.pair,f.x,'等待前台取件','pending');
  const notice={pending_inbound:AGY_WAKE_NOTICE};
  assert.deepEqual(await hint(),notice);
  assert.deepEqual(await hint(),{});
  const start=await f.hook('SessionStart');
  const texts=start.injectSteps!.map(step=>step.systemMessage.systemMessage);
  assert.ok(texts.includes(AGY_WAKE_NOTICE));
  assert.match(texts.join('\n'),/agybridge recovery facts rev/);
  assert.doesNotMatch(texts.join('\n'),/partner recovery digest|等待前台取件/);
  const turn=await f.hook('PreInvocation');
  assert.ok(turn.injectSteps?.some(step=>step.systemMessage.systemMessage===AGY_WAKE_NOTICE));
  assert.deepEqual(await hint(),notice);
  assert.deepEqual(await hint(),{});
  f.broker.receive(f.actor);
  assert.equal(f.store.message(unread.id).state,'contextObserved');
  assert.deepEqual(await hint(),{});
});

test('AGY 前台仅为未答复的明确请求在正常 Stop 补一次 wait_partner',async t=>{
  const f=foregroundPair(t);
  f.send('fyi',false);
  assert.deepEqual(await f.hook('Stop'),{});
  f.send('task');
  const first=await f.hook('Stop',{terminationReason:'NO_TOOL_CALL'});
  assert.equal(first.decision,'continue');assert.match(first.reason!,/codex\.wait_partner once/);
  f.send('task');
  assert.deepEqual(await f.hook('Stop'),{},'重试同一条消息不能重新触发');
  for(const reason of ['ERROR','MAX_INVOCATIONS','MAX_FORCED_INVOCATIONS','MAX_TOKEN_BUDGET_EXCEEDED','TERMINAL_CUSTOM_HOOK']){
    f.send(reason);
    assert.deepEqual(await f.hook('Stop',{terminationReason:reason}),{});
    assert.deepEqual(await f.hook('Stop'),{});
  }
  f.send('already-continuing');
  assert.deepEqual(await f.hook('Stop',{continuationActive:true}),{});
  assert.deepEqual(await f.hook('Stop'),{});
  f.store.saveEndpoint({...f.store.endpoint(f.a.id)!,mode:'agy-acp'});
  f.send('background');
  assert.deepEqual(await f.hook('Stop'),{});
});

test('AGY 优先读取已经到达的回复；显式取件和已挂起的等待器不再补提醒',async t=>{
  const f=foregroundPair(t);
  const first=f.send('before-stop');
  f.store.accept(f.pair,f.x,'完成','reply-first',first.message_id);
  assert.deepEqual(await f.hook('Stop'),{decision:'continue',reason:AGY_WAKE_NOTICE});
  f.broker.receive(f.actor);
  assert.deepEqual(await f.hook('Stop'),{});
  const second=f.send('before-receive');
  f.store.accept(f.pair,f.x,'收到','reply-second',second.message_id);
  f.broker.receive({...f.actor,callId:'receive-second'});
  assert.equal(f.store.setting('agyAwaitReply:'+f.a.id),null);
  assert.deepEqual(await f.hook('Stop'),{});
  f.send('parked');
  const parked=f.broker.dispatch('agy.wait',{actor:f.actor,timeout_ms:5000});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.broker.hasAgyWaiter(f.a.id),true);
  assert.deepEqual(await f.hook('Stop'),{});
  f.broker.wakeAgyWaiter(f.a.id);
  await parked;
  assert.deepEqual(await f.hook('Stop'),{});
});

test('AGY 前台提问补一次等待提示；结束的问题和暂停前的请求不带入新回合',async t=>{
  const f=foregroundPair(t);
  const asked=await f.broker.dispatch('question.create',{actor:f.actor,questions:[{id:'format',header:'格式',question:'采用哪种格式？'}]}) as {request_id:string};
  const stop=await f.hook('Stop');
  assert.equal(stop.decision,'continue');assert.match(stop.reason!,/codex\.wait_partner once/);
  assert.deepEqual(await f.hook('Stop'),{});
  await f.broker.dispatch('question.cancel',{actor:f.actor,request_id:asked.request_id});
  const next=await f.broker.dispatch('question.create',{actor:{...f.actor,callId:'next-question'},questions:[{id:'choice',header:'选择',question:'采用哪一项？'}]}) as {request_id:string};
  await f.broker.dispatch('question.cancel',{actor:f.actor,request_id:next.request_id});
  f.broker.receive(f.actor);
  assert.deepEqual(await f.hook('Stop'),{});
  f.send('abandoned');
  await f.hook('Stop',{terminationReason:'USER_CANCELED'});
  assert.equal(f.store.peer(f.a.id).state,'paused');
  assert.equal(f.store.setting('agyAwaitReply:'+f.a.id),null);
});

test('AGY 的 PostToolUse 读到压缩后，下一次 PreInvocation 从相同转录恢复窗口内的消息且只注入一次',async t=>{
  const f=foregroundPair(t),home=f.store.endpoint(f.a.id)!.configHome!;
  const before=f.store.accept(f.pair,f.a,'不在压缩窗口的正文','other');
  const included=f.store.accept(f.pair,f.a,'压缩窗口内的工作决定','inside');
  for(const message of [before,included])f.store.transition(message.id,'contextObserved');
  const file=path.join(home,'transcript_full.jsonl');
  const at=new Date().toISOString();
  const rows=[
    {step_index:1,type:'PLANNER_RESPONSE',created_at:at,tool_calls:[{name:'mcp_codex_send_message'}]},
    {step_index:2,source:'MODEL',type:'GENERIC',created_at:at,content:JSON.stringify({persisted:true,message_id:included.id})},
    {step_index:3,type:'CHECKPOINT',created_at:at,content:'summary'},
  ];
  writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const invoke=(event:string)=>runHook('agy',{conversationId:'c',hookEventName:event,transcriptPath:file},()=>{},{
    home,agy:{configHome:home,identity:{pid:process.pid,procStart:'test',acp:false}},
    call:async <T>(method:string,params?:unknown)=> (method==='mcp.register'?{id:f.a.id}:method==='context.lookup'?{}:await f.broker.dispatch(method,params)) as T,
  }) as Promise<{injectSteps?:{systemMessage:{systemMessage:string}}[]}>;
  assert.deepEqual(await invoke('PostToolUse'),{});
  const recovered=await invoke('PreInvocation');
  const text=recovered.injectSteps!.map(step=>step.systemMessage.systemMessage).join('\n');
  assert.match(text,/agybridge recovery facts rev/);
  assert.match(text,/1 actual exchange msgs/);
  assert.match(text,/压缩窗口内的工作决定/);
  assert.doesNotMatch(text,/不在压缩窗口的正文/);
  assert.deepEqual(await invoke('PreInvocation'),{});
});

test('AGY PostToolUse 的真实输入用量在后续 PreInvocation 触发长上下文提醒',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=foregroundPair(t,{syncTipMinutes:2,contextTipTokens:[500]});
  f.store.updatePeer(f.x.id,{state:'ready'});
  await f.hook('PreInvocation');
  t.mock.timers.tick(60001);
  await f.hook('PostToolUse',{agy_transcript:{usage:{tokens:550,at:Date.now()}}});
  const next=await f.hook('PreInvocation');
  assert.ok(next.injectSteps?.some(step=>step.systemMessage.systemMessage.includes('long context')));
  assert.deepEqual(await f.hook('PreInvocation'),{});
});

test('暂停、离线、结束上下文及解除配对时丢弃 AGY 待回复标记',async t=>{
  for(const action of ['pause','offline','end-context','unpair']){
    const f=foregroundPair(t);
    const key='agyAwaitReply:'+f.a.id;
    f.send('tracked');
    assert.ok(f.store.setting(key));
    if(action==='end-context')f.store.endContext(f.actor);
    else if(action==='offline')await f.broker.dispatch('peer.state',{actor:f.actor,state:'offline'});
    else await f.broker.dispatch(action,{pair_id:f.pair.id});
    assert.equal(f.store.setting(key),null,action);
  }
});

test('恢复原 AGY 会话时提供已丢失配对的原因和原配对标识',async t=>{
  const f=foregroundPair(t);
  f.store.unpair(f.pair.id,{reason:'identity_mismatch'});
  const start=await f.hook('SessionStart');
  const text=start.injectSteps!.map(step=>step.systemMessage.systemMessage).join('\n');
  assert.match(text,/identity_mismatch/);
  assert.ok(text.includes(f.pair.id));
  assert.doesNotMatch(text,/partner recovery digest/);
});

test('AGY 重启跳过 SessionStart 时按进程代次恢复一次配对事实',async t=>{
  const f=foregroundPair(t);
  const proc={host:'agy' as const,configHome:f.store.endpoint(f.a.id)!.configHome!,pid:5000};
  const activate=(procStart:string)=>f.store.bindings.activate({...proc,procStart},f.a.id,'c','resume');
  const facts=async(event:string,binding:ReturnType<typeof activate>)=>{
    const result=await f.hook(event,{actor:{...f.actor,binding:{key:binding.key,epoch:binding.epoch}}});
    return result.injectSteps?.map(step=>step.systemMessage.systemMessage).filter(text=>text.includes('agybridge recovery facts rev'))??[];
  };
  const first=activate('first');
  assert.deepEqual(await facts('PreInvocation',first),[]);
  const resumed=activate('second');
  f.store.accept(f.pair,f.x,'已通过等待器投递的正文','wake-reply');
  const wake=await f.broker.dispatch('agy.wait',{actor:{...f.actor,binding:{key:resumed.key,epoch:resumed.epoch}},timeout_ms:5000}) as {status:string};
  assert.equal(wake.status,'received');
  assert.deepEqual(await facts('PreInvocation',resumed),[]);
  const restored=await facts('PreInvocation',resumed);
  assert.equal(restored.length,1);
  assert.ok(restored[0]!.includes(f.pair.id)&&restored[0]!.includes(resumed.epoch));
  assert.doesNotMatch(restored[0]!,/partner recovery digest|已通过等待器投递的正文/);
  assert.deepEqual(await facts('PreInvocation',resumed),[]);
  const restarted=activate('third');
  assert.equal((await facts('SessionStart',restarted)).length,1);
  assert.deepEqual(await facts('PreInvocation',restarted),[]);
});

test('AGY 转录路径按会话目录、文件名及原生进程代次匹配',()=>{
  const native={host:'agy' as const,pid:321,procStart:'start'};
  const key='321:start:/profile/brain/conv-1/.system_generated/logs/transcript.jsonl';
  assert.equal(hookContextMatches(key,'conv-1',native),true);
  assert.equal(hookContextMatches(String.raw`321:start:C:\profile\brain\conv-1\.system_generated\logs\transcript_full.jsonl`,'conv-1',native),true);
  assert.equal(hookContextMatches(key,'conv',native),false);
  assert.equal(hookContextMatches(key.replace('transcript.jsonl','other.jsonl'),'conv-1',native),false);
  assert.equal(hookContextMatches(key,'conv-1',{...native,procStart:'old'}),false);
  const codex={...native,host:'codex' as const};
  assert.equal(hookContextMatches(key,'conv-1',codex),false);
});

function subagentReport(id:string,body:string):string{
  return JSON.stringify({type:'SYSTEM_MESSAGE',source:'SYSTEM',content:'[Message] timestamp=2026-11-26T08:21:00Z sender='+id+' priority=MESSAGE_PRIORITY_HIGH content='+body})+'\n';
}

test('AGY 刚收到子代理报告就可发引用，Codex 收到展开的报告',t=>{
  const f=foregroundPair(t),endpoint=f.store.endpoint(f.a.id)!;
  const file=path.join(endpoint.configHome!,'transcript_full.jsonl');
  const id='bf0395eb-a7ca-4bd1-a023-950d0460330c',body='检查完成，改动在计划文件第 15 行。';
  writeFileSync(file,subagentReport(id,body));
  f.store.saveEndpoint({...endpoint,nativeSession:{transcriptPath:file}});
  const sent=f.send('nxref:agent:'+id,false);
  const received=f.broker.receive({host:'codex',sessionId:'x',callId:'pickup-report'}) as {messages:{message_id:string;message:string}[]};
  assert.equal(received.messages[0]?.message_id,sent.message_id);
  assert.equal(received.messages[0]?.message,'[nxref agent:'+id+']\n'+body+'\n[/nxref]');
  writeFileSync(file,'');
  assert.equal(f.broker.references.expand(f.a,'nxref:agent:'+id),received.messages[0]!.message);
  assert.throws(()=>f.broker.references.expand(f.x,'nxref:agent:'+id),{code:'ref_missing'});
});

test('AGY 单独出现子代理回报的转录在 PostToolUse 后即可提示复用',async t=>{
  const f=foregroundPair(t),home=f.store.endpoint(f.a.id)!.configHome!;
  const file=path.join(home,'transcript.jsonl'),id='bf0395eb-a7ca-4bd1-a023-950d0460330d';
  const body='已验证各个入口的行为。'.repeat(45);
  writeFileSync(file,subagentReport(id,body));
  await runHook('agy',{conversationId:'c',hookEventName:'PostToolUse',transcriptPath:file},()=>{},{
    home,agy:{configHome:home,identity:{pid:process.pid,procStart:'test',acp:false}},
    call:async <T>(method:string,params?:unknown)=>(method==='context.lookup'?{}:await f.broker.dispatch(method,params)) as T,
  });
  const result=await f.broker.dispatch('send',{actor:f.actor,message:body}) as {tip?:string};
  assert.ok(result.tip?.includes('nxref:agent:'+id));
});

test('AGY 原生发信和工作流展开引用，保留脚本和字面量并拒绝无法解析的引用',async t=>{
  const f=foregroundPair(t),source=f.store.accept(f.pair,f.x,'使用已确认的计划','plan');
  const ref='nxref:msg:'+source.id,expanded='[nxref msg:'+source.id+']\n使用已确认的计划\n[/nxref]';
  const call=(name:string,args:Record<string,unknown>,conversationId='c')=>f.hook('PreToolUse',{conversationId,toolCall:{name,args}});
  assert.deepEqual(await call('send_message',{Target:'child',Message:ref}),{decision:'allow',overwrite:{Target:'child',Message:expanded}});
  const args={Script:'nxref:msg:missing',Args:{input:[{report:ref},3,null],'nxref:msg:missing':false}};
  assert.deepEqual(await call('run_workflow',args),{decision:'allow',overwrite:{...args,Args:{input:[{report:expanded},3,null],'nxref:msg:missing':false}}});
  assert.deepEqual(await call('run_workflow',{Script:ref,Args:['"'+ref+'"',true]}),{decision:'allow'});
  for(const [name,args] of [['send_message',{Message:'nxref:msg:missing'}],['run_workflow',{Args:[{report:'nxref:msg:missing'}]}]] as const){
    for(const session of ['c','unregistered']){
      const result=await call(name,args,session);
      assert.equal(result.decision,'deny');assert.match(result.reason!,/nxref/);
    }
  }
});

test('AGY 同进程子代理触发 SessionStart/PreInvocation/Stop 时不抢占根窗口绑定，不泄漏恢复事实且不导致根发信 stale_context',async t=>{
  const f=foregroundPair(t),ep=f.store.endpoint(f.a.id)!,home=ep.configHome!;
  const runtime={pid:ep.pid!,procStart:ep.procStart!,acp:false};
  const callBroker=async <T>(method:string,params?:unknown)=>await f.broker.dispatch(method,params) as T;
  const execHook=(conversationId:string,hookEventName:string,extra:Record<string,unknown>={})=>runHook(
    'agy',
    {conversationId,hookEventName,...extra},
    ()=>{},
    {home,agy:{configHome:home,identity:runtime},call:callBroker},
  ) as Promise<any>;

  // 1. Register and bind root conversation 'c' on foreground window
  const rootStart=await execHook('c','SessionStart');
  assert.ok(Array.isArray(rootStart.injectSteps));
  const initialBinding=f.store.bindings.current(f.a.id)!;
  assert.equal(initialBinding.sessionId,'c');

  // 2. Scenario A: Subagent discovered via parent .system_generated/subagents/<id>.json (real InvokeSubagent order)
  const subA='sub-hub-86950829';
  const hubDir=path.join(agyArtifactsDir(home,'c'),'.system_generated','subagents');
  mkdirSync(hubDir,{recursive:true});
  writeFileSync(path.join(hubDir,`${subA}.json`),JSON.stringify({conversationId:subA,state:'SUBAGENT_STATE_ALIVE'}));

  assert.deepEqual(await execHook(subA,'SessionStart'),{});
  assert.deepEqual(await execHook(subA,'PreInvocation'),{});
  assert.deepEqual(await execHook(subA,'PreToolUse',{toolCall:{id:'st-1',name:'invoke_subagent',args:{Prompt:'nested research'}}}),{decision:'allow'});
  const subDeniedRef=await execHook(subA,'PreToolUse',{toolCall:{id:'st-2',name:'invoke_subagent',args:{Prompt:'nxref:agent:missing'}}});
  assert.equal(subDeniedRef.decision,'deny');
  assert.deepEqual(await execHook(subA,'Stop',{terminationReason:'USER_CANCELED'}),{});

  const subPeerA=f.store.find('agy',subA)!;
  assert.equal(subPeerA.kind,'subagent');
  assert.equal(subPeerA.parentId,'c');
  assert.equal(subPeerA.rootPeerId,f.a.id);
  assert.equal(f.store.peer(f.a.id).sessionId,'c');
  assert.equal(f.store.peer(f.a.id).state,'ready');
  assert.equal(f.store.bindings.current(f.a.id)?.epoch,initialBinding.epoch);

  // 3. Scenario B: Pure in-flight PreToolUse(invoke_subagent) without disk files (e.g. workflow/synthetic spawn)
  const subB='991195eb-a7ca-4bd1-a023-950d0460330e';
  assert.deepEqual(await execHook('c','PreToolUse',{toolCall:{id:'root-inv-1',name:'invoke_subagent',args:{Prompt:'scan codebase'}}}),{decision:'allow'});
  assert.deepEqual(await execHook(subB,'SessionStart'),{});
  assert.deepEqual(await execHook(subB,'Stop',{terminationReason:'NO_TOOL_CALL'}),{});
  const rootTranscript=path.join(agyArtifactsDir(home,'c'),'.system_generated','logs','transcript.jsonl');
  mkdirSync(path.dirname(rootTranscript),{recursive:true});
  writeFileSync(rootTranscript,subagentReport(subB,'子代理扫描完成：共 3 处改动点。'));
  assert.deepEqual(await execHook('c','PostToolUse',{transcriptPath:rootTranscript,toolCall:{id:'root-inv-1',name:'invoke_subagent'}}),{});

  const subPeerB=f.store.find('agy',subB)!;
  assert.equal(subPeerB.kind,'subagent');
  assert.equal(subPeerB.parentId,'c');
  assert.equal(f.store.bindings.current(f.a.id)?.sessionId,'c');
  assert.equal(f.store.bindings.current(f.a.id)?.epoch,initialBinding.epoch);

  // 4. Root conversation immediately sends message referencing nxref:agent:<subB> + parks wait_partner -> NO stale_context!
  const rootActor={host:'agy' as const,sessionId:'c',callId:'after-sub-send',binding:{key:initialBinding.key,epoch:initialBinding.epoch}};
  const sent=await f.broker.dispatch('send',{actor:rootActor,message:`结果：nxref:agent:${subB}`,reply_expected:true}) as {message_id:string};
  assert.ok(sent.message_id);
  const codexReceived=f.broker.receive({host:'codex',sessionId:'x',callId:'rx-after-sub'}) as {messages:{message:string}[]};
  assert.match(codexReceived.messages[0]!.message,/子代理扫描完成：共 3 处改动点。/);
});

test('detectAgySubagentLineage 识别转录头部与 conversation_summaries.db 并区分真实用户根会话',async t=>{
  const home=temporary(t),appData=path.join(home,'antigravity-cli');
  mkdirSync(appData,{recursive:true});

  // 1. Transcript starting with USER_EXPLICIT -> confirmed root
  const rootLogs=path.join(appData,'brain','root-1','.system_generated','logs');
  mkdirSync(rootLogs,{recursive:true});
  writeFileSync(path.join(rootLogs,'transcript.jsonl'),JSON.stringify({step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',content:'hello'})+'\n');
  assert.deepEqual(detectAgySubagentLineage({conversationId:'root-1',configHome:home}),{isSubagent:false});

  // 2. Transcript starting with SYSTEM [Message] sender=<parent> -> confirmed subagent
  const childLogs=path.join(appData,'brain','child-1','.system_generated','logs');
  mkdirSync(childLogs,{recursive:true});
  writeFileSync(path.join(childLogs,'transcript.jsonl'),subagentReport('root-1','请扫描文件'));
  assert.deepEqual(detectAgySubagentLineage({conversationId:'child-1',configHome:home}),{isSubagent:true,parentId:'root-1'});

  // 3. conversation_summaries.db fallback (before transcript exists at SessionStart)
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(path.join(appData,'conversation_summaries.db'));
  db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, agent_name TEXT NOT NULL DEFAULT "", parent_conversation_id TEXT NOT NULL DEFAULT "", nesting_depth INTEGER NOT NULL DEFAULT 0)');
  db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?)').run('child-db','research','root-1',1);
  db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?)').run('root-db','','',0);
  db.close();

  assert.deepEqual(detectAgySubagentLineage({conversationId:'child-db',configHome:home}),{isSubagent:true,parentId:'root-1'});
  assert.deepEqual(detectAgySubagentLineage({conversationId:'root-db',configHome:home}),{isSubagent:false});
});
