import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { temporary, temporaryDirectory } from './support/temporary.js';
import { fixture } from './support/broker-fixture.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { agyAppDataDir, agyAppDataDirs, resolveAgyAppDataDir } from '../shared/local-paths.js';
import { agyArtifactsDir, agySessionExists, detectAgySubagentLineage } from '../hosts/agy/identity.js';
import { sessionEvidenceFile } from '../hosts/session-launch.js';
import { launchInputFingerprint } from '../hosts/launch-park.js';
import { recordSessionHistory, sessionHistoryState, verifySessionHistory } from '../broker/recovery/session-history.js';
import { restoreState } from '../broker/pairing/pair-restore.js';
import { cleanInstanceEnvironment, referencedAuthEnvironment } from '../process/environment.js';
import { AgyAdapter } from '../hosts/agy/adapter.js';
import { registerSchema } from '../broker/requests/contracts.js';
import { permissionFacts } from '../integration/mcp/permission-guidance.js';
import type { Endpoint, Message, Peer, PermissionClass } from '../types.js';

function put(file:string,text=''){
  mkdirSync(path.dirname(file),{recursive:true});
  writeFileSync(file,text);
}

test('AGY 只在自己的配置目录内发现会话，CLI 默认值与 IDE 的已有会话可并存',t=>{
  const home=temporary(t),cli=agyAppDataDir(home),ide=path.join(home,'antigravity'),legacy=path.join(home,'antigravity-ide');
  const custom=path.join(home,'custom'),roots=[cli,ide,legacy];
  assert.deepEqual(agyAppDataDirs(home,{ANTIGRAVITY_APP_DATA_DIR:custom}),[custom,...roots]);
  assert.deepEqual(agyAppDataDirs(home,{ANTIGRAVITY_APP_DATA_DIR:cli}),roots);
  for(const hint of ['relative',path.join(home,'..','other')])assert.deepEqual(agyAppDataDirs(home,{ANTIGRAVITY_APP_DATA_DIR:hint}),roots);
  assert.equal(resolveAgyAppDataDir(home,'new'),cli);
  const db=path.join(ide,'conversations','chat.db');
  put(db);
  assert.equal(resolveAgyAppDataDir(home,'new'),ide);
  mkdirSync(path.join(cli,'brain','chat','scratch'),{recursive:true});
  assert.equal(resolveAgyAppDataDir(home,'new'),cli);
  assert.equal(agyArtifactsDir(home,'chat'),path.join(ide,'brain','chat'));
  assert.equal(sessionEvidenceFile('agy',home,'chat'),db);
  assert.equal(agySessionExists(home,'chat'),true);
  mkdirSync(path.join(legacy,'brain','scratch-only','scratch'),{recursive:true});
  assert.equal(agySessionExists(home,'scratch-only'),false);
  put(path.join(cli,'conversations','chat.pb'));
  assert.equal(sessionEvidenceFile('agy',home,'chat'),undefined);
  const {a}=fixture(t);
  assert.equal(restoreState({...a,sessionId:'chat',owner:'nxbridge'},home),'unverified');
});

test('AGY 历史可使用独立 IDE 存储；已登记的存储消失时保留未知状态',async t=>{
  const {a,store}=fixture(t),home=temporary(t);
  const root=path.join(home,'antigravity-ide'),brain=path.join(root,'brain');
  const file=path.join(brain,a.sessionId!,'.system_generated','logs','transcript.jsonl');
  put(file,JSON.stringify({sessionId:a.sessionId})+'\n');
  const ep={...store.endpoint(a.id)!,configHome:home,nativeSession:{transcriptPath:file}};
  recordSessionHistory(store,a,ep);
  assert.equal(sessionHistoryState(store,a,ep),'present');
  renameSync(brain,path.join(root,'moved-brain'));
  mkdirSync(path.join(home,'antigravity-cli','brain'),{recursive:true});
  assert.equal(await verifySessionHistory(store,a,ep,{fresh:true}),'unknown');
  const db=new DatabaseSync(path.join(root,'conversation_summaries.db'));
  try{
    db.exec("CREATE TABLE conversation_summaries(conversation_id TEXT,parent_conversation_id TEXT,agent_name TEXT,nesting_depth INTEGER); INSERT INTO conversation_summaries VALUES('child','parent','research',1)");
  }finally{db.close();}
  assert.deepEqual(detectAgySubagentLineage({configHome:home,conversationId:'child'}),{isSubagent:true,parentId:'parent'});
});

test('独立启动清除 AGY 会话环境，IDE 配置的认证变量和改动仍可识别',t=>{
  const home=temporary(t),keys=['LS_ADDRESS','LS_VERSION','CSRF_TOKEN','TRAJECTORY_ID','SOURCE_METADATA','PROJECT_ID','SIDECAR_PORT','APP_DATA_DIR'].map(key=>'ANTIGRAVITY_'+key);
  const env=Object.fromEntries(keys.map(key=>[key,'fixture']));
  assert.deepEqual(cleanInstanceEnvironment({...env,LANG:'C'}).env,{LANG:'C'});
  const peer={host:'agy' as const,sessionId:null,cwd:home};
  let prior=launchInputFingerprint(home,DEFAULT_CONFIG,peer,home);
  for(const surface of ['antigravity','antigravity-ide']){
    put(path.join(home,surface,'settings.json'),JSON.stringify({env_key:'PROJECT_AUTH'}));
    const current=launchInputFingerprint(home,DEFAULT_CONFIG,peer,home);
    assert.notEqual(current,prior);prior=current;
  }
  assert.deepEqual(referencedAuthEnvironment('agy',home,{PROJECT_AUTH:'fixture'}),{PROJECT_AUTH:'fixture'});
});

// The fixture records the actual argv, requests, and permission replies seen on ACP stdio.
const testHost=`
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const file=process.argv[2],sid='p2-session';
const record=value=>appendFileSync(file,JSON.stringify(value)+'\\n');
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const options=[{value:'default'},{value:'plan'}];
const config=value=>[{id:'mode',category:'mode',currentValue:value,options}];
const modes=value=>({currentModeId:value,availableModes:options.map(option=>({id:option.value}))});
record({argv:process.argv.slice(3)});
let prompt;
createInterface({input:process.stdin}).on('line',line=>{
  const {id,method,params,result}=JSON.parse(line);
  if(!method){
    if(id==='permission'){
      record({outcome:result.outcome});
      send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'current_mode_update',currentModeId:'default'}}});
      send({id:prompt,result:{stopReason:'end_turn'}});
    }
    return;
  }
  record({method,params});
  if(method==='session/prompt'){
    prompt=id;
    send({id:'permission',method:'session/request_permission',params:{sessionId:sid,toolCall:{toolCallId:'call',title:'Review change'},options:[{kind:'reject_once',optionId:'disallow'},{kind:'allow_once',optionId:'once'}]}});
  }else if(id!==undefined){
    let response={};
    if(method==='session/new')response={sessionId:sid,configOptions:config('default'),modes:modes('default')};
    if(method==='session/resume')response={sessionId:sid,modes:modes('default')};
    if(method==='session/set_config_option')response={configOptions:config(params.value)};
    if(method==='session/set_mode')response={modes:modes(params.modeId)};
    send({id,result:response});
  }
});
`;

function acpFixture(t:TestContext,permission:PermissionClass){
  const temp=temporaryDirectory(),root=temp.directory,configHome=path.join(root,'gemini'),log=path.join(root,'wire.jsonl'),script=path.join(root,'acp.mjs');
  put(script,testHost);
  const adapter=new AgyAdapter({...DEFAULT_CONFIG,agyCommand:[process.execPath,script,log],agyHome:configHome,questionTimeoutMs:permission==='unknown'?200:30000},path.join(root,'bridge'));
  const peer:Peer={id:'p2-peer',host:'agy',sessionId:null,cwd:root,name:'AGY',kind:'root',parentId:null,owner:'nxbridge',permission,state:'starting',updatedAt:0};
  t.after(async()=>{try{await adapter.release(peer);}finally{adapter.close();await temp.cleanup();}});
  const rows=()=>readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  return {adapter,peer,rows,configHome};
}

for(const permission of ['prompting','unknown','bypass'] as const){
  test('AGY ACP 启动与实际审批结果遵守 '+permission,{timeout:15000},async t=>{
    const {adapter,peer,rows}=acpFixture(t,permission);
    const reg=await adapter.create(peer,undefined,permission,undefined,undefined,'plan');
    const target={...peer,sessionId:reg.sessionId};
    const endpoint:Endpoint={...reg.endpoint,peerId:peer.id,active:true,seenAt:0};
    const native=registerSchema.parse(reg).endpoint.nativePermission!;
    assert.equal(reg.permission,permission);
    assert.equal(native.permission,permission);
    assert.equal(native.mode,'plan');
    assert.deepEqual(permissionFacts(target,endpoint),{class:permission,mode:'plan',observed_at:native.observedAt});
    assert.equal(rows()[0].argv.includes('--dangerously-skip-permissions'),permission==='bypass');
    assert.ok(rows().some(row=>row.method==='session/set_config_option'&&row.params.configId==='mode'&&row.params.value==='plan'));
    const sender:Peer={...peer,id:'codex-sender',host:'codex'};
    const message:Message={id:'m1',pairId:'pair',from:sender.id,to:peer.id,body:'Review change',callId:'send',state:'sending',createdAt:0,updatedAt:0,attempts:1,inReplyTo:null,via:null,evidence:null,error:null};
    const completed=once(adapter,'turnCompleted'),modeChanged=once(adapter,'permission');
    const waiting=new Promise<void>(resolve=>adapter.on('state',(_id:string,state:string)=>{if(state==='needsHuman')resolve();}));
    await adapter.deliver(target,endpoint,message,sender);
    if(permission!=='bypass'){
      await waiting;
      assert.equal(adapter.healthOf(peer.id)?.state,'needsHuman');
      assert.ok(adapter.healthOf(peer.id)?.humanRequests?.length);
      assert.equal(rows().some(row=>row.outcome),false);
      if(permission==='prompting')await adapter.interrupt(target);
    }
    await completed;
    const [sid,observedPermission,mode]=await modeChanged;
    assert.deepEqual([sid,observedPermission,mode],[reg.sessionId,permission,'default']);
    assert.deepEqual(rows().find(row=>row.outcome)?.outcome,permission==='bypass'?{outcome:'selected',optionId:'once'}:{outcome:'cancelled'});
    assert.equal(adapter.healthOf(peer.id)?.humanRequests?.length??0,0);
  });
}

test('恢复 IDE 会话使用原应用目录和目标权限，并按旧宿主公布的 mode 切换',async t=>{
  const {adapter,peer,rows,configHome}=acpFixture(t,'prompting');
  const target={...peer,sessionId:'p2-session'},dir=path.join(configHome,'antigravity');
  put(path.join(dir,'conversations',target.sessionId+'.db'));
  const reg=await adapter.wake(target,undefined,undefined,undefined,undefined,'plan');
  const argv:string[]=rows()[0].argv;
  assert.ok(argv.includes('--app-data-dir'));assert.equal(argv[argv.indexOf('--app-data-dir')+1],dir);
  assert.equal(argv.includes('--dangerously-skip-permissions'),false);
  assert.ok(rows().some(row=>row.method==='session/set_mode'&&row.params.modeId==='plan'));
  assert.equal(reg.endpoint.nativePermission?.mode,'plan');
  assert.equal(reg.endpoint.nativePermission?.permission,'prompting');
  const changed=await adapter.wake(target,undefined,undefined,undefined,undefined,'default');
  assert.equal(changed.endpoint.nativePermission?.mode,'default');
  assert.deepEqual(rows().filter(row=>row.method==='session/set_mode').map(row=>row.params.modeId),['plan','default']);
});

test('ACP 不选未公布的 mode，不在两个同名会话间猜测恢复目标',async t=>{
  const {adapter,peer,configHome,rows}=acpFixture(t,'unknown');
  await assert.rejects(adapter.create(peer,undefined,'unknown',undefined,undefined,'not-advertised'),{code:'agy_mode_unsupported'});
  assert.ok(!rows().some(row=>row.method==='session/set_mode'||row.method==='session/set_config_option'));
  const launches=rows().filter(row=>row.argv).length;
  const target={...peer,sessionId:'duplicate'};
  for(const surface of ['antigravity','antigravity-cli'])put(path.join(configHome,surface,'conversations','duplicate.db'));
  await assert.rejects(adapter.wake(target),{code:'agy_session_ambiguous'});
  assert.equal(rows().filter(row=>row.argv).length,launches);
});
