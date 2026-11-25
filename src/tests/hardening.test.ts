import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Store } from '../storage/store.js';
import { FaultBoundary } from '../broker/fault-boundary.js';
import { pairLossView } from '../broker/pairing/pair-restore.js';
import {DeliveryHealth} from '../broker/health/delivery.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporaryDirectory } from './support/temporary.js';
import { WindowRecovery } from '../broker/recovery/window-recovery.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';

test('同一坏记录只诊断一次，修复后恢复读取且不会使所有配对降级',t=>{
  const {store,c}=fixture(t),db=(store as any).db,raw=db.prepare('SELECT data FROM peers WHERE id=?').get(c.id).data;
  db.prepare('UPDATE peers SET data=? WHERE id=?').run('{broken',c.id);
  for(let index=0;index<20;index++)assert.equal(store.getPeer(c.id),undefined);
  const failures=()=>store.events().filter(event=>event.type==='pump.failed'&&(event.data as any).stage==='record:peer:'+c.id);
  assert.equal(failures().length,1);assert.equal(store.faults.status().find(value=>value.stage==='record:peer:'+c.id)?.degraded,false);
  db.prepare('UPDATE peers SET data=? WHERE id=?').run(raw,c.id);assert.ok(store.getPeer(c.id));
  assert.equal(store.faults.status().some(value=>value.stage==='record:peer:'+c.id),false);
  db.prepare('UPDATE peers SET data=? WHERE id=?').run('{broken-again',c.id);store.getPeer(c.id);assert.equal(failures().length,2);
});

test('单组配对的成员不可解析时，全局状态 RPC 仍可读取并保留原配对',async t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id);
  (store as any).db.prepare('UPDATE peers SET data=? WHERE id=?').run('{broken',c.id);
  const result=await broker.dispatch('status',{}) as any;
  assert.equal(result.pair.id,pair.id);assert.ok(result.peers.some((peer:any)=>peer.id===x.id));
  assert.equal(store.pairFor(c.id)?.id,pair.id);
});

test('相同记录连续故障进入有上限的退避，其他记录及恢复后工作继续',async()=>{
  let now=1000,calls=0;const events:unknown[]=[],faults=new FaultBoundary((_type,data)=>events.push(data),()=>now);
  for(let i=0;i<8;i++)await faults.run('bad',()=>{calls++;throw Error('坏记录 '+i);});
  assert.equal(calls,3);assert.equal(faults.status()[0]!.degraded,true);
  assert.equal(await faults.run('healthy',()=>calls++),true);assert.equal(calls,4);
  now=6001;assert.equal(await faults.run('bad',()=>calls++),true);assert.deepEqual(faults.status(),[]);assert.equal(events.length,3);
});

test('原生事件同步异常和异步登记拒绝均不逃出宿主回调，正常投递继续',async t=>{
  const {store,broker,c,x,codex,agy}=fixture(t),pair=store.pair(c.id,x.id),message=store.accept(pair,x,'继续服务','isolated-event');
  const peer=(broker as any).runtimePeer.bind(broker);(broker as any).runtimePeer=()=>{throw Error('事件记录故障');};
  assert.doesNotThrow(()=>codex.emit('state','bad','ready'));
  (broker as any).runtimePeer=peer;(broker as any).windowRecovery.register=async()=>{throw Error('异步登记故障');};
  assert.doesNotThrow(()=>codex.emit('register',registration('codex','new')));
  await broker.pump();assert.equal(store.message(message.id).state,'runtimeQueued');assert.equal(agy.delivered.length,1);
  assert.ok(store.faults.status().some(row=>row.stage.startsWith('event:state:')));
  assert.ok(store.faults.status().some(row=>row.stage.startsWith('event:register:')));
});

test('坏暂停窗口不会阻断其他配对的消息，也不会让全局等待提前结束',async t=>{
  const {store,broker,c,x,agy}=fixture(t),pair=store.pair(c.id,x.id),message=store.accept(pair,x,'独立队列','healthy-pair');
  const paused=store.register(registration('codex','broken-paused'));store.updatePeer(paused.id,{state:'paused'});
  const probe=(broker as any).runtimeHealth.probeRuntime.bind((broker as any).runtimeHealth);(broker as any).runtimeHealth.probeRuntime=(peer:any,...args:unknown[])=>peer.id===paused.id?Promise.reject(Error('单窗口查询失败')):probe(peer,...args);
  await broker.pump();assert.equal(store.message(message.id).state,'runtimeQueued');assert.equal(agy.delivered.length,1);
  assert.ok(store.faults.status().some(row=>row.stage==='paused_window:'+paused.id));
});

test('启动清除旧悬空引用，不可解析成员保留原文并留下阶段诊断',async t=>{
  const temp=temporaryDirectory(),file=path.join(temp.directory,'bridge.db');let store=new Store(file);
  const c=store.register(registration('agy','healthy')),x=store.register(registration('codex','healthy')),pair=store.pair(c.id,x.id),bad=store.register(registration('agy','bad'));
  store.setSetting('windowRecoveryPending',{gone:{peerId:'gone',input:{}}});store.setSetting('managedSessionConflict:'+c.id,{memberId:'gone'});store.close();
  const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'),db=new DatabaseSync(file);db.prepare('UPDATE peers SET data=? WHERE id=?').run('{broken',bad.id);db.close();
  store=new Store(file);t.after(async()=>{store.close();await temp.cleanup();});
  assert.deepEqual(store.setting('windowRecoveryPending'),{});assert.equal(store.setting('managedSessionConflict:'+c.id),undefined);
  assert.equal(store.peers().length,2);assert.equal(store.pairs()[0]!.id,pair.id);
  assert.ok(store.faults.status().some(event=>event.stage==='record:peer:'+bad.id));
  assert.equal((store as any).db.prepare('SELECT data FROM peers WHERE id=?').get(bad.id).data,'{broken');
});

test('前搭档被保留策略清除后，解配事实仍可读取且恢复状态为 gone',async t=>{
  const {store,c,x}=fixture(t),pair=store.pair(c.id,x.id);store.unpair(pair.id,{reason:'window_exit'});
  store.deactivate(c.id);store.updatePeer(c.id,{state:'offline'});
  store.maintain({historyMaxAgeMs:1,peerMaxIdleMs:1},Date.now()+1000);
  assert.equal(store.getPeer(c.id),undefined);const loss=pairLossView(store,store.peer(x.id));
  assert.equal(loss?.partner_id,c.id);assert.equal(loss?.restore_state,'gone');
});

test('单个不可解析成员不阻断其他配对，端点记录不被读取副作用删除',async t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id),bad=store.register(registration('codex','bad'));
  store.saveEndpoint({...store.endpoint(bad.id)!,pendingContext:true});
  const child=store.register(registration('codex','orphan-child'));store.updatePeer(child.id,{rootPeerId:bad.id,state:'paused'});
  (store as any).db.prepare('UPDATE peers SET data=? WHERE id=?').run('{invalid',bad.id);
  const message=store.accept(pair,x,'健康配对仍可投递','healthy-after-corruption');await broker.pump();
  assert.equal(store.message(message.id).state,'runtimeQueued');assert.doesNotThrow(()=>store.maintain());
  assert.equal(store.endpoints(bad.id).length,1);assert.ok(store.faults.status().some(row=>row.stage==='record:peer:'+bad.id));
});

test('持续降级在运行时通知和状态中可见，不额外唤醒或重发消息',async t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id);
  for(let i=0;i<3;i++)store.faults.failed('isolated_record',Error('变化的错误 '+i));
  (broker as any).runtimeHealth.refreshNoticeConditions(pair);
  const notice=new DeliveryHealth(store).peek(pair.id,c.id).find(value=>value.source==='broker_degraded');
  assert.equal(notice?.wake,false);assert.match(notice!.message,/doctor once/);
  assert.ok((broker.status() as any).capabilities.degraded.some((value:any)=>value.stage==='isolated_record'));
});

test('消失记录的降级状态在五分钟无活动后过期，稀疏错误不累计成永久降级',()=>{
  let now=1000;const faults=new FaultBoundary(()=>{},()=>now);
  for(let i=0;i<3;i++)faults.failed('deleted-record',Error('瞬态错误 '+i));assert.equal(faults.status()[0]!.degraded,true);
  now+=300001;assert.deepEqual(faults.status(),[]);assert.equal(faults.ready('deleted-record'),true);
  faults.failed('deleted-record',Error('新的错误'));assert.equal(faults.status()[0]!.count,1);
  now+=300001;faults.failed('deleted-record',Error('很晚的错误'));assert.equal(faults.status()[0]!.count,1);
});

test('成员暂时无法解析时保留接管租约、恢复预算和恢复记录',async t=>{
  const temp=temporaryDirectory(),filename=path.join(temp.directory,'bridge.db');let store=new Store(filename);
  t.after(async()=>{store.close();await temp.cleanup();});
  const c=store.register(registration('agy','corrupt')),x=store.register(registration('codex','partner')),pair=store.pair(c.id,x.id);
  const lease={id:'lease',peerId:c.id},budget={state:'unknown',attempts:[{id:'spent-attempt'}]},pending={peerId:c.id,input:registration('agy','corrupt'),state:'unverified',deadline:Date.now()+60000,nextAt:0};
  store.setSetting('takeover:'+c.id,lease);store.setSetting('managedRecovery:'+c.id,budget);store.setSetting('windowRecoveryPending',{[c.id]:pending});store.setSetting('managedSessionConflict:'+x.id,{memberId:c.id,pairId:pair.id});
  const db=(store as any).db,raw=db.prepare('SELECT data FROM peers WHERE id=?').get(c.id).data;db.prepare('UPDATE peers SET data=? WHERE id=?').run('{newer-version',c.id);store.close();store=new Store(filename);
  await new WindowRecovery(store,async()=>{throw Error('不可解析成员不得触发原生查询');}).retry(()=>{});store.maintain();
  assert.deepEqual(store.setting('takeover:'+c.id),lease);assert.deepEqual(store.setting('managedRecovery:'+c.id),budget);
  assert.deepEqual(store.setting<Record<string,unknown>>('windowRecoveryPending')?.[c.id],pending);assert.ok(store.setting('managedSessionConflict:'+x.id));
  assert.equal(store.endpoints(c.id).length,1);assert.equal((store as any).db.prepare('SELECT count(*) AS n FROM endpoints WHERE peer_id=?').get(c.id).n,1);
  (store as any).db.prepare('UPDATE peers SET data=? WHERE id=?').run(raw,c.id);assert.equal(store.endpoints(c.id).length,1);assert.equal(store.pairFor(c.id)?.id,pair.id);
});

test('自有记录新增枚举值和字段不被旧版读取器隐藏或丢弃',t=>{
  const {store,c}=fixture(t),db=(store as any).db;
  const future={...store.peer(c.id),state:'future-state',kind:'future-kind',future:{revision:2}};
  db.prepare('UPDATE peers SET data=? WHERE id=?').run(JSON.stringify(future),c.id);
  assert.deepEqual(store.getPeer(c.id),future);assert.ok(store.peers().some(peer=>peer.id===c.id));
  assert.deepEqual(store.faults.status(),[]);
});

test('设置解析失败回滚嵌套业务事务，原记录留在原表',t=>{
  const {store,c}=fixture(t),key='takeover:'+c.id,db=(store as any).db;store.setSetting(key,{});db.prepare('UPDATE settings SET value=? WHERE key=?').run('{invalid',key);
  assert.throws(()=>store.transaction(()=>{store.setSetting('must-rollback',true);store.transaction(()=>store.setting(key));}),{code:'record_invalid'});
  assert.equal(store.setting('must-rollback'),undefined);assert.equal(db.prepare('SELECT value FROM settings WHERE key=?').get(key).value,'{invalid');
});

test('损坏的单个冲突记录不会阻断其他未配对窗口的发送和配对检查',async t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);const key='managedSessionConflict:'+c.id;store.setSetting(key,{});(store as any).db.prepare('UPDATE settings SET value=? WHERE key=?').run('{invalid',key);
  const user=store.register(registration('agy','healthy-unpaired')),recovery=new WindowRecovery(store);
  const target=store.register(registration('codex','healthy-candidate'));
  assert.doesNotThrow(()=>recovery.assertUnbound(user));assert.equal(recovery.hold({actor:{host:'agy',memberId:user.id,sessionId:user.sessionId!,callId:'send'},message:'正常发送'},DEFAULT_CONFIG),undefined);
  const result=await broker.dispatch('send',{actor:{host:'agy',memberId:user.id,sessionId:user.sessionId!,callId:'selection'},message:'正常选择搭档'}) as any;assert.equal(result.status,'selection_required');assert.ok(result.candidates.some((value:any)=>value.member_id===target.id));
  assert.ok(store.faults.status().some(row=>row.stage==='managed_conflict_scan:'+c.id));
});
