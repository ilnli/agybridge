import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { classifyCodexPermission, codexMetadataEvidence } from '../hosts/codex/codex-permission.js';
import { codexPermission } from '../hosts/codex/adapter.js';
import { permissionGuidance } from '../integration/mcp/permission-guidance.js';
import { nativeDeliveryWait } from '../broker/delivery/delivery-guidance.js';
import { pairIssues } from '../broker/pairing/pair-anomalies.js';
import { VERSION } from '../version.js';
import { processIdentity } from '../process/process.js';

test('所有 Codex 原生证据共用分类器，完整访问本身不推断绕过，真实审查优先',()=>{
  for(const [sandbox,approval,autoReview,expected] of [
    ['read-only','bypass',false,'prompting'],['workspace-write','bypass',false,'prompting'],
    ['danger-full-access',undefined,undefined,'unknown'],['danger-full-access','bypass',false,'bypass'],
    ['danger-full-access','bypass',true,'bypass'],['danger-full-access','prompting',false,'prompting'],
  ] as const){
    assert.equal(classifyCodexPermission({sandbox,approval,autoReview}),expected);
    assert.equal(codexPermission({sandbox:{type:sandbox},approvalPolicy:approval==='bypass'?'never':approval==='prompting'?'on-request':undefined,autoReviewEnabled:autoReview}),expected);
    assert.equal(classifyCodexPermission(codexMetadataEvidence({sandbox_mode:sandbox,...(approval?{approval_policy:approval==='bypass'?'never':'on-request'}:{}),auto_review_enabled:autoReview})),expected);
  }
});

test('待审批的后台发送返回暂停和原会话恢复入口，共享 daemon 与新空窗口准确区分',async t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);store.updatePeer(x.id,{owner:'nxbridge',state:'needsHuman'});
  const address=store.endpoint(x.id)!.address;
  broker.health.observe(address,{id:7,method:'item/commandExecution/requestApproval',params:{threadId:'x',turnId:'turn',itemId:'command'}});
  const result=await broker.dispatch('send',{actor:{host:'agy',sessionId:'c',callId:'approval'},message:'保留的任务'}) as any;
  assert.equal(result.status,'paused');assert.equal(result.delivery_wait.reason,'native_approval');assert.equal(result.delivery_wait.open_command,'agybridge open codex --member '+x.id);
  assert.deepEqual(result.delivery_wait.native_request,{turn_id:'turn',item_id:'command',method:'item/commandExecution/requestApproval'});
  const peer=store.peer(x.id),endpoint=store.endpoint(x.id)!;
  assert.equal(nativeDeliveryWait({...peer,owner:'user'},endpoint,1).delivery_wait?.open_command,undefined);
  assert.equal(nativeDeliveryWait(peer,{...endpoint,daemon:{address:'native-daemon'}},1).delivery_wait?.open_command,undefined);
  const fresh=nativeDeliveryWait({...peer,sessionId:null,state:'ready'},{...endpoint,pendingContext:true},1).delivery_wait!;
  assert.equal(fresh.reason,'awaiting_first_prompt');assert.match(fresh.message,/输入一条消息/);
});

test('简短恢复命令只列同项目、存活、自有、正在等待的专用 Codex，多候选保留给终端选择',async t=>{
  const {store,broker,c,x}=fixture(t),native=await processIdentity(process.pid);store.pair(c.id,x.id);
  const activate=(id:string)=>{store.updatePeer(id,{owner:'nxbridge',state:'needsHuman'});store.saveEndpoint({...store.endpoint(id)!,pid:native.pid,procStart:native.startedAt});};
  activate(x.id);
  const list=async(cwd=c.cwd)=>(await broker.dispatch('open.candidates',{cwd}) as any).candidates;
  assert.deepEqual((await list()).map((row:any)=>row.member_id),[x.id]);assert.deepEqual(await list(path.resolve('/other-project')),[]);
  const other=store.register(registration('codex','other')),otherAgy=store.register(registration('agy','other-agy'));store.pair(otherAgy.id,other.id);activate(other.id);
  assert.equal((await list()).length,2);
  store.updatePeer(other.id,{owner:'user'});assert.equal((await list()).length,1);
  store.updatePeer(other.id,{owner:'nxbridge',state:'busy'});assert.equal((await list()).length,1);
  store.updatePeer(other.id,{state:'needsHuman'});store.saveEndpoint({...store.endpoint(other.id)!,daemon:{address:'native-daemon'}});assert.equal((await list()).length,1);
  store.saveEndpoint({...store.endpoint(x.id)!,procStart:'old-generation'});assert.deepEqual(await list(),[]);
});

test('只有明确且尚未解决的原生拒绝在轮次结束后产生一次告警，非零退出仅为工具事实',t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id),base={turnId:'turn',lastProgressAt:Date.now(),lastEventAt:Date.now(),state:'ready' as const,tools:[]};
  const health={...base,nativeIssue:{kind:'approval_denied' as const,turn_id:'turn',item_id:'tool',at:Date.now()}},detect=(value=health)=>broker.pairAnomalies.observe(pair,x,value);
  detect();detect();assert.equal(store.events().filter(event=>event.type==='health.pair.alert'&&(event.data as any).kind==='native_denied').length,0);assert.equal(broker.deliveryHealth.hasPending(pair.id,c.id),false);
  assert.equal(broker.pairAnomalies.issues(x.id)[0]?.kind,'native_denied');
  broker.pairAnomalies.observe(pair,x,{...base,nativeIssue:{...health.nativeIssue,kind:'tool_failed',exit_code:1}});assert.deepEqual(broker.pairAnomalies.issues(x.id),[]);
  assert.equal(pairIssues({pair,peer:x,now:Date.now(),messages:[],transitioning:false,questionPending:false,integration:{scope:'test',since:Date.now(),turnsWithoutHook:0},version:VERSION,health:{...health,state:'running'}}).some(issue=>issue.kind==='native_denied'),false);
});
