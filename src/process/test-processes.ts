import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import {atomicJson,readJson} from '../shared/files.js';
import {delay} from '../shared/time.js';
import { type ProcessIdentity } from './process.js';
import { ownedProcesses, ownedRecordState, processRegistryDirectory, processRegistryRoot, releaseRecordedProcesses, ownedContainerComplete, completeOwnedContainer, type OwnedProcessRecord } from './owned-processes.js';
import { ownedProcessState, stopOwnedProcess, stopOwnedGroup } from './process-stop.js';
import { stopWindowsJob } from './windows/windows-hook-identity.js';
import { brokerCall } from '../ipc/ipc.js';
import {describeError} from '../shared/errors.js';

function canonical(value:string):string{
  let parent=path.resolve(value);const tail:string[]=[];
  for(;;)try{return path.join(realpathSync.native(parent),...tail.reverse());}catch(error){
    if(path.dirname(parent)===parent)throw error;
    if((error as NodeJS.ErrnoException).code!=='ENOENT'){
      let missing=false;try{lstatSync(parent);}catch(statError){missing=(statError as NodeJS.ErrnoException).code==='ENOENT';}
      if(!missing)throw error;
    }
    tail.push(path.basename(parent));parent=path.dirname(parent);
  }
}
const inside=(root:string,value:string)=>{const relative=path.relative(canonical(root),canonical(value));return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
interface TestRoot {scope:string;directory:string;createdAt:number;processRegistry?:string}
const rootsDirectory=()=>path.join(processRegistryRoot(),'test-roots');
function testRecords<T>(directory:string,report?:(file:string,error:unknown)=>void):T[]{
  let names:string[];try{names=readdirSync(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];if(!report)throw error;report(directory,error);return[];}
  return names.filter(name=>name.endsWith('.json')).flatMap(name=>{
    const file=path.join(directory,name);
    try{return[readJson<T>(file)];}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];if(!report)throw error;report(file,error);return[];}
  });
}
function roots():TestRoot[]{return testRecords<TestRoot>(rootsDirectory()).filter(value=>value.scope===process.env.AGYBRIDGE_TEST_SCOPE);}
export function registerTestDirectory(directory:string,processRegistry?:string):void{
  const scope=process.env.AGYBRIDGE_TEST_SCOPE;if(!scope)return;
  if(processRegistry&&(!inside(directory,processRegistry)||path.resolve(directory)===path.resolve(processRegistry)))throw Error('子测试进程登记目录必须位于隔离夹具内');
  mkdirSync(rootsDirectory(),{recursive:true,mode:0o700});atomicJson(path.join(rootsDirectory(),createHash('sha256').update(directory).digest('hex')+'.json'),{scope,directory:path.resolve(directory),createdAt:Date.now(),...(processRegistry?{processRegistry:path.resolve(processRegistry)}:{})});
}
function externalHomes(directory:string|undefined,notes:Set<string>):string[]{
  const root=processRegistryRoot(),scope=process.env.AGYBRIDGE_TEST_SCOPE,result=new Set<string>();if(!existsSync(root))return[];
  const candidates=new Set<string>(directory?[processRegistryDirectory(directory)]:[]);
  for(const record of generations(directory)){result.add(record.home);candidates.add(processRegistryDirectory(record.home));}
  const directories=directory?[...candidates]:readdirSync(root,{withFileTypes:true}).filter(value=>value.isDirectory()&&/^[a-f0-9]{24}$/.test(value.name)).map(value=>path.join(root,value.name));
  const report=(file:string,error:unknown)=>notes.add(`测试归属证据无法读取 ${file}：${describeError(error)}；保留监督目录。`);
  for(const location of directories)for(const value of testRecords<{home?:string;scope?:string}>(location,report)){
    if(typeof value?.home!=='string'||!path.isAbsolute(value.home)||processRegistryDirectory(value.home)!==location){report(location,Error('归属目录与 home 不符'));continue;}
    if(value.scope===scope&&(!directory||inside(directory,value.home)))result.add(value.home);
  }
  return[...result];
}
function generations(directory?:string):OwnedProcessRecord[]{
  return testRecords<OwnedProcessRecord>(path.join(processRegistryRoot(),'test-generations')).filter(record=>{
    if(record.scope!==process.env.AGYBRIDGE_TEST_SCOPE)return false;
    if(record.version!==1||typeof record.home!=='string'||!path.isAbsolute(record.home)||!Number.isSafeInteger(record.identity?.pid)||record.identity.pid<=0||typeof record.identity.startedAt!=='string'||!record.identity.startedAt)throw Error('测试进程代次凭据损坏，保留监督目录');
    return!directory||inside(directory,record.home);
  });
}
export async function cleanupTestProcesses(directory?:string):Promise<{pids:number[];notes:string[];processes:{pid:number;procStart:string;after:string}[];diagnostics:string[]}>{
  if(!process.env.AGYBRIDGE_TEST_SCOPE)return{pids:[],notes:[],processes:[],diagnostics:[]};
  const notes:string[]=[],pids:number[]=[],identities=new Map<string,Pick<ProcessIdentity,'pid'|'startedAt'>>(),diagnostics:string[]=[],ownershipNotes=new Set<string>();
  const registered=roots(),protectedHomes=JSON.parse(process.env.AGYBRIDGE_TEST_PROTECTED_HOMES??'[]') as string[];
  const allowed=(value:string)=>!protectedHomes.some(home=>inside(home,value))&&registered.some(root=>{try{return inside(root.directory,value);}catch(error){if(['EPERM','EACCES','ENOENT'].includes((error as NodeJS.ErrnoException).code??''))return false;throw error;}});
  const rejected=new Set<string>(),reject=(home:string)=>{if(!rejected.has(home)){rejected.add(home);notes.push('拒绝清理未登记的测试目录：'+home+'；未关闭协调器或释放其进程。');}};
  if(directory&&!allowed(directory)){reject(directory);return{pids,notes,processes:[],diagnostics};}
  const permitted=(home:string)=>{if(allowed(home))return true;reject(home);return false;};
  for(const home of externalHomes(directory,ownershipNotes)){
    if(!permitted(home))continue;
    const snapshot=ownedProcesses(home),before={notes:snapshot.notes,records:snapshot.records.filter(record=>record.scope===process.env.AGYBRIDGE_TEST_SCOPE)};
    notes.push(...before.notes);pids.push(...before.records.map(record=>record.identity.pid));
    for(const record of before.records)for(const identity of [record.identity,...(record.windowsHolder?[record.windowsHolder]:[])]){pids.push(identity.pid);identities.set(identity.pid+':'+identity.startedAt,identity);}
    try{
      if(snapshot.records.some(record=>record.scope!==process.env.AGYBRIDGE_TEST_SCOPE))throw Error('隔离目录含其他会话的归属记录，未关闭协调器');
      await brokerCall('shutdown',{releaseOwned:true,reason:'test_cleanup',requester:{pid:process.pid,command:'cleanupTestProcesses'}},{home,start:false,timeout:8000});
      const deadline=Date.now()+2000;
      for(const record of before.records.filter(value=>value.role==='broker'))while(await ownedProcessState(record.identity)==='alive'&&Date.now()<deadline)await delay(50);
    }catch(error){if(!['ENOENT','ECONNREFUSED','EPIPE','disconnected'].includes((error as {code?:string}).code??''))diagnostics.push('隔离 broker 正常关闭未完成：'+describeError(error));}
    notes.push(...await releaseRecordedProcesses(home,record=>record.scope===process.env.AGYBRIDGE_TEST_SCOPE));
  }
  for(const record of generations(directory)){
    if(!permitted(record.home))continue;
    if(record.identity.pid===process.pid)continue;
    const key=record.identity.pid+':'+record.identity.startedAt;pids.push(record.identity.pid);identities.set(key,record.identity);
    if(record.windowsHolder){pids.push(record.windowsHolder.pid);identities.set(record.windowsHolder.pid+':'+record.windowsHolder.startedAt,record.windowsHolder);}
    try{if(record.windowsJob){if(!ownedContainerComplete(record))try{await stopWindowsJob(record.windowsJob,record.identity);completeOwnedContainer(record);}catch(error){if(!ownedContainerComplete(record))throw error;}if(record.windowsHolder)await stopOwnedProcess(record.windowsHolder);}else if(record.posixGroup){if(!ownedContainerComplete(record)){await stopOwnedGroup(record.identity);completeOwnedContainer(record);}}else await stopOwnedProcess(record.identity);}catch(error){notes.push(`测试进程 ${key} 的最终回收未完成：${describeError(error)}`);}
  }
  const remaining=externalHomes(directory,ownershipNotes).filter(home=>allowed(home)).flatMap(home=>ownedProcesses(home).records.filter(record=>record.scope===process.env.AGYBRIDGE_TEST_SCOPE));
  for(const record of remaining)if(await ownedRecordState(record)!=='dead')notes.push(`隔离进程 ${record.identity.pid}/${record.identity.startedAt} 尚未核验退出；归属证据保留于 ${processRegistryRoot()}`);
  const processes:{pid:number;procStart:string;after:string}[]=await Promise.all([...identities.values()].map(async identity=>({pid:identity.pid,procStart:identity.startedAt,after:await ownedProcessState(identity)})));
  for(const value of processes)if(value.after!=='dead')notes.push(`测试进程 ${value.pid}/${value.procStart} 的最终状态为 ${value.after}，未清除证据。`);
  const linked=roots().filter(root=>root.processRegistry&&inside(root.directory,root.processRegistry)&&(!directory||inside(directory,root.directory)));
  for(const root of linked){
    if(!existsSync(root.processRegistry!)||path.resolve(root.processRegistry!)===path.resolve(processRegistryRoot()))continue;
    const previous=process.env.AGYBRIDGE_PROCESS_REGISTRY;
    try{process.env.AGYBRIDGE_PROCESS_REGISTRY=root.processRegistry!;const child=await cleanupTestProcesses(root.directory);pids.push(...child.pids);notes.push(...child.notes);processes.push(...child.processes);diagnostics.push(...child.diagnostics);}
    finally{if(previous===undefined)delete process.env.AGYBRIDGE_PROCESS_REGISTRY;else process.env.AGYBRIDGE_PROCESS_REGISTRY=previous;}
  }
  notes.push(...ownershipNotes);return{pids,notes,processes,diagnostics};
}
