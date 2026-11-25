import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { existsSync, mkdirSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {atomicJson} from '../shared/files.js';
import {ensureHome} from '../ipc/home.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { processIdentity } from '../process/process.js';
import { ownedProcessState, stopOwnedProcess } from '../process/process-stop.js';
import { forgetOwnedProcess, processRegistryDirectory, processRegistryRoot, rememberOwnedChild } from '../process/owned-processes.js';
import { listenBroker } from '../ipc/ipc.js';
import { cleanupTestProcesses, registerTestDirectory } from '../process/test-processes.js';
import { temporaryDirectory } from './support/temporary.js';

const execute=promisify(execFile);

test('测试代次记录不能授权关闭夹具外的 home，目录联接也不能绕过边界',async t=>{
  const temp=temporaryDirectory(),fixture=path.join(temp.directory,'fixture'),outside=path.join(temp.directory,'outside'),registry=path.join(temp.directory,'registry');
  mkdirSync(fixture);await ensureHome(outside);
  const previous=process.env.AGYBRIDGE_PROCESS_REGISTRY;process.env.AGYBRIDGE_PROCESS_REGISTRY=registry;registerTestDirectory(fixture);
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}),closed=once(child,'close');await once(child,'spawn');
  const proof=await rememberOwnedChild(outside,child,'proxy');assert.ok(proof);let shutdowns=0;
  const server=await listenBroker(outside,async()=>{shutdowns++;return{stopping:true};});
  t.after(async()=>{await server.close();await stopOwnedProcess(proof.identity);await closed;forgetOwnedProcess(proof);if(previous===undefined)delete process.env.AGYBRIDGE_PROCESS_REGISTRY;else process.env.AGYBRIDGE_PROCESS_REGISTRY=previous;await temp.cleanup();});
  for(const home of [outside,path.join(fixture,'link')]){
    if(home!==outside)symlinkSync(outside,home,process.platform==='win32'?'junction':'dir');
    const result=await cleanupTestProcesses();
    assert.equal(shutdowns,0,'不能向夹具外协调器发出关闭请求');
    assert.equal(await ownedProcessState(proof.identity),'alive','不能因污染的 home 记录停止进程');
    assert.ok(result.notes.some(note=>note.includes('拒绝清理')));
    if(home!==outside)assert.deepEqual((await cleanupTestProcesses(home)).pids,[]);
  }
});

test('正式 home 即使被误登记为夹具也不获得关闭权限',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'protected'),previousRegistry=process.env.AGYBRIDGE_PROCESS_REGISTRY,previousProtected=process.env.AGYBRIDGE_TEST_PROTECTED_HOMES;
  await ensureHome(home);process.env.AGYBRIDGE_PROCESS_REGISTRY=path.join(temp.directory,'registry');process.env.AGYBRIDGE_TEST_PROTECTED_HOMES=JSON.stringify([home]);registerTestDirectory(home);
  let shutdowns=0;const server=await listenBroker(home,async()=>{shutdowns++;return{};});
  t.after(async()=>{await server.close();if(previousRegistry===undefined)delete process.env.AGYBRIDGE_PROCESS_REGISTRY;else process.env.AGYBRIDGE_PROCESS_REGISTRY=previousRegistry;if(previousProtected===undefined)delete process.env.AGYBRIDGE_TEST_PROTECTED_HOMES;else process.env.AGYBRIDGE_TEST_PROTECTED_HOMES=previousProtected;await temp.cleanup();});
  const result=await cleanupTestProcesses(home);assert.equal(shutdowns,0);assert.match(result.notes.join(' '),/拒绝清理/);
});

test('原生路径解析失败仅在确认目录已删除后继续回收，存活目录的错误仍保留',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'removed'),previous=process.env.AGYBRIDGE_PROCESS_REGISTRY;
  mkdirSync(home);process.env.AGYBRIDGE_PROCESS_REGISTRY=path.join(temp.directory,'registry');registerTestDirectory(home);
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}),closed=once(child,'close');await once(child,'spawn');
  const proof=await rememberOwnedChild(home,child,'host-control'),original=fs.realpathSync.native;assert.ok(proof);rmdirSync(home);
  t.mock.method(fs.realpathSync,'native',(...args:Parameters<typeof original>)=>{
    if(path.resolve(String(args[0]))===home)throw Object.assign(Error('目录删除期间原生路径解析失败'),{code:'EBADF',syscall:'realpath',path:home});
    return Reflect.apply(original,fs.realpathSync,args);
  });
  t.after(async()=>{t.mock.restoreAll();try{await stopOwnedProcess(proof.identity);await closed;}finally{if(previous===undefined)delete process.env.AGYBRIDGE_PROCESS_REGISTRY;else process.env.AGYBRIDGE_PROCESS_REGISTRY=previous;await temp.cleanup();}});
  const result=await cleanupTestProcesses(home);
  assert.deepEqual(result.notes,[]);assert.ok(result.processes.some(value=>value.pid===proof.identity.pid&&value.after==='dead'));await closed;
  mkdirSync(home);await assert.rejects(cleanupTestProcesses(home),{code:'EBADF'});
});

test('归属先于进程退出被删除时，监督器仍按原代次回收独立子进程',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge');mkdirSync(home);
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true}),closed=once(child,'close');
  await once(child,'spawn');child.unref();const proof=await rememberOwnedChild(home,child,'broker');assert.ok(proof);
  t.after(async()=>{try{await stopOwnedProcess(proof.identity);await closed;}finally{await temp.cleanup();}});
                                         
  forgetOwnedProcess(proof);rmdirSync(home);
  const result=await cleanupTestProcesses(temp.directory);
  assert.equal(await ownedProcessState(proof.identity),'dead');
  assert.ok(result.processes.some(value=>value.pid===proof.identity.pid&&value.procStart===proof.identity.startedAt&&value.after==='dead'));
  assert.deepEqual(result.notes,[]);
});

test('正常关闭先删除 broker 归属记录时，清理器等待原代次退出后再回收',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge');await ensureHome(home);
  const child=spawn(process.execPath,['-e',"process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.exit(),600));"],{stdio:['pipe','ignore','ignore'],windowsHide:true}),closed=once(child,'close');
  await once(child,'spawn');const proof=await rememberOwnedChild(home,child,'broker');assert.ok(proof);
  const server=await listenBroker(home,async method=>{assert.equal(method,'shutdown');forgetOwnedProcess(proof);child.stdin!.end();return{stopping:true,notes:[]};});
  t.after(async()=>{await server.close();try{await stopOwnedProcess(proof.identity);await closed;}finally{await temp.cleanup();}});
  const result=await cleanupTestProcesses(temp.directory);
  assert.deepEqual(result.notes,[]);assert.deepEqual(result.diagnostics,[]);
  assert.ok(result.processes.some(value=>value.pid===proof.identity.pid&&value.procStart===proof.identity.startedAt&&value.after==='dead'));
});

test('并行测试只读取已发布的 JSON，临时文件不影响清理，正式损坏记录仍报错',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge');mkdirSync(home);
  const previous=process.env.AGYBRIDGE_PROCESS_REGISTRY;process.env.AGYBRIDGE_PROCESS_REGISTRY=path.join(temp.directory,'registry');registerTestDirectory(temp.directory);
  const directory=path.join(processRegistryRoot(),'test-roots');mkdirSync(directory,{recursive:true});
  const files=[path.join(directory,'并行写入.json.fixture.tmp'),path.join(directory,'损坏记录.json')];
  t.after(async()=>{for(const file of files)if(existsSync(file))unlinkSync(file);if(previous===undefined)delete process.env.AGYBRIDGE_PROCESS_REGISTRY;else process.env.AGYBRIDGE_PROCESS_REGISTRY=previous;await temp.cleanup();});
  writeFileSync(path.join(directory,'并行写入.json.fixture.tmp'),'{','utf8');
  assert.deepEqual((await cleanupTestProcesses(temp.directory)).notes,[]);
  const file=path.join(directory,'损坏记录.json');writeFileSync(file,'{','utf8');
  await assert.rejects(cleanupTestProcesses(temp.directory),SyntaxError);
  assert.ok(existsSync(file));unlinkSync(file);
});

test('单夹具不读取并行夹具的损坏归属，全局收尾仍报告并保留全部证据',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'current'),other=path.join(temp.directory,'other'),previous=process.env.AGYBRIDGE_PROCESS_REGISTRY;
  await ensureHome(home);mkdirSync(other);
  process.env.AGYBRIDGE_PROCESS_REGISTRY=path.join(temp.directory,'registry');registerTestDirectory(home);registerTestDirectory(other);
  const marker=(owner:string)=>{
    const id=randomUUID(),directory=processRegistryDirectory(owner),file=path.join(directory,'native-'+id+'.json');mkdirSync(directory,{recursive:true});
    atomicJson(file,{version:1,id,peerId:id,home:owner,configHome:owner,phase:'intent',scope:process.env.AGYBRIDGE_TEST_SCOPE,createdAt:Date.now()});return file;
  };
  marker(home);
  const otherDirectory=processRegistryDirectory(other);mkdirSync(otherDirectory,{recursive:true});
  const unrelated=[path.join(otherDirectory,'native-'+randomUUID()+'.json'),path.join(otherDirectory,randomUUID()+'.json')];
  for(const file of unrelated)writeFileSync(file,'{','utf8');
  let shutdowns=0;const server=await listenBroker(home,async()=>{shutdowns++;return{stopping:true};});
  const read=new Set<string>(),original=fs.readFileSync;
  t.mock.method(fs,'readFileSync',(...args:any[])=>{read.add(String(args[0]));return Reflect.apply(original,fs,args);});syncBuiltinESMExports();
  t.after(async()=>{t.mock.restoreAll();syncBuiltinESMExports();await server.close();if(previous===undefined)delete process.env.AGYBRIDGE_PROCESS_REGISTRY;else process.env.AGYBRIDGE_PROCESS_REGISTRY=previous;await temp.cleanup();});
  const first=await cleanupTestProcesses(home);
  assert.deepEqual(first.notes,[]);assert.deepEqual(first.pids,[]);assert.equal(shutdowns,1,'没有进程代次的当前 home 仍应发现原生启动记录');
  assert.ok(unrelated.every(file=>!read.has(file)),'范围筛选必须发生在读取无关记录之前');
  const local=path.join(processRegistryDirectory(home),'native-'+randomUUID()+'.json');writeFileSync(local,'{','utf8');
  const scoped=await cleanupTestProcesses(home);
  assert.ok(scoped.notes.some(note=>note.includes(local)));assert.ok(unrelated.every(file=>!read.has(file)));
  const global=await cleanupTestProcesses();
  for(const file of [...unrelated,local]){assert.ok(read.has(file));assert.ok(global.notes.some(note=>note.includes(file)));assert.ok(existsSync(file),'损坏证据不能在报告前后被删除');}
  assert.deepEqual(global.pids,[],'仅有原生意图记录不能获得进程终止权限');
});

test('外层监督器回收夹具内单独登记目录的子进程，拒绝目录越界',async t=>{
  const temp=temporaryDirectory(),registry=path.join(temp.directory,'child-registry'),home=path.join(temp.directory,'bridge'),previous=process.env.AGYBRIDGE_PROCESS_REGISTRY;
  registerTestDirectory(temp.directory,registry);assert.throws(()=>registerTestDirectory(temp.directory,path.dirname(temp.directory)),/必须位于隔离夹具内/);
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}),closed=once(child,'close');await once(child,'spawn');const identity=await processIdentity(child.pid!);
  t.after(async()=>{if(previous===undefined)delete process.env.AGYBRIDGE_PROCESS_REGISTRY;else process.env.AGYBRIDGE_PROCESS_REGISTRY=previous;try{await stopOwnedProcess(identity);await closed;}finally{await temp.cleanup();}});
  try{process.env.AGYBRIDGE_PROCESS_REGISTRY=registry;registerTestDirectory(temp.directory);assert.ok(await rememberOwnedChild(home,child,'host-control'));}
  finally{if(previous===undefined)delete process.env.AGYBRIDGE_PROCESS_REGISTRY;else process.env.AGYBRIDGE_PROCESS_REGISTRY=previous;}
  const result=await cleanupTestProcesses(temp.directory);assert.deepEqual(result.notes,[]);assert.ok(result.processes.some(p=>p.pid===identity.pid&&p.procStart===identity.startedAt&&p.after==='dead'));await closed;
});

test('极短测试宿主先登记再执行，正常退出不误报进程身份丢失',{timeout:30000},async()=>{
  const {stdout}=await execute(process.execPath,[path.join(PACKAGE_ROOT,'tools','run-tests.mjs'),'--input-type=module','-e',"console.log('快速宿主已执行')"],{cwd:PACKAGE_ROOT,windowsHide:true,timeout:25000,maxBuffer:1024*1024});
  assert.match(stdout,/快速宿主已执行/);
  const cleanup=JSON.parse(stdout.split(/\r?\n/).find(line=>line.startsWith('{"testProcessCleanup":'))!).testProcessCleanup;
  assert.ok(cleanup.processes.length>0);assert.ok(cleanup.processes.every((value:{after:string})=>value.after==='dead'));
  assert.deepEqual(cleanup.notes,[]);assert.deepEqual(cleanup.trackingErrors,[]);
});
test('独立监督器在正常结束、宿主崩溃和会话超时后释放已登记的隔离子进程',{timeout:120000},async()=>{
  const module=(name:string)=>JSON.stringify(pathToFileURL(path.join(PACKAGE_ROOT,'dist/process',name+'.js')).href);
  for(const mode of ['normal','crash','timeout']){
    const script=`import{spawn}from'node:child_process';import{once}from'node:events';import{mkdirSync}from'node:fs';import path from'node:path';import{rememberOwnedChild,releaseOwnedProcess}from ${module('owned-processes')};const home=path.join(process.env.AGYBRIDGE_PROCESS_REGISTRY,'fixture');mkdirSync(home);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});await once(child,'spawn');child.unref();const proof=await rememberOwnedChild(home,child,'host-control');console.log('fixtureIdentity='+JSON.stringify(proof.identity));if(${JSON.stringify(mode)}==='normal'){await releaseOwnedProcess(proof);}else if(${JSON.stringify(mode)}==='crash'){process.exit(23);}else{setInterval(()=>{},1000);}`;
    let stdout='',code=0;
    try{stdout=(await execute(process.execPath,[path.join(PACKAGE_ROOT,'tools','run-tests.mjs'),'--input-type=module','-e',script],{cwd:PACKAGE_ROOT,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,AGYBRIDGE_TEST_SESSION_TIMEOUT_MS:mode==='timeout'?'15000':'30000'}})).stdout;}
    catch(error){const value=error as {stdout?:string;code?:number};stdout=value.stdout??'';code=value.code??1;}
    assert.equal(code,mode==='normal'?0:mode==='crash'?23:124,stdout);
    const identity=JSON.parse(/^fixtureIdentity=(.+)$/m.exec(stdout)![1]!);
    assert.equal(await ownedProcessState(identity),'dead',mode+' 的隔离子进程必须退出');
    const result=stdout.split(/\r?\n/).find(line=>line.startsWith('{"testProcessCleanup":'));
    assert.ok(result,stdout);const cleanup=JSON.parse(result).testProcessCleanup;
    assert.deepEqual(cleanup.notes,[]);assert.deepEqual(cleanup.trackingErrors,[]);
    assert.ok(cleanup.processes.every((value:{after:string})=>value.after==='dead'));
  }
});
