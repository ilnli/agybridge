import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import type { Store } from '../storage/store.js';
import {readJson} from '../shared/files.js';
import { matchesProcess, processIdentity } from './process.js';
import { ownedProcesses, recordOwnedProcess, type OwnedProcessRole } from './owned-processes.js';
import {describeError} from '../shared/errors.js';
import { managedMarker } from '../install/installation.js';

interface LegacyProof {role:OwnedProcessRole;pid:number;generation:string;peerId?:string;sessionId?:string;configHome?:string;source:'runtime'|'ledger'}
export async function migrateLegacyOwnership(home:string,store:Store):Promise<string[]>{
  if(store.setting('ownedProcessMigrationComplete'))return[];
  let snapshot=store.setting<LegacyProof[]>('ownedProcessMigrationSnapshot');
  if(!snapshot){
    snapshot=[];
    const runtime=path.join(home,'run','codex-runtime.json');
    if(existsSync(runtime)){const saved=readJson<{pid:number;procStart?:string;configHome?:string}>(runtime);if(saved.pid&&saved.procStart)snapshot.push({role:'codex-runtime',pid:saved.pid,generation:saved.procStart,configHome:saved.configHome,source:'runtime'});}
    const run=path.join(home,'run');
    if(existsSync(run))for(const name of readdirSync(run).filter(value=>/^runtime-.*\.json$/.test(value))){
      const value=readJson<{owner?:string;pid?:number;generation?:string}>(path.join(run,name));
      if(value.owner===managedMarker(home)&&value.pid&&value.generation)snapshot.push({role:'broker',pid:value.pid,generation:value.generation,source:'runtime'});
    }
    store.setSetting('ownedProcessMigrationSnapshot',snapshot);
  }
  const notes:string[]=[],existing=ownedProcesses(home).records;
  for(const proof of snapshot){
    if(proof.peerId&&store.peers().find(value=>value.id===proof.peerId)?.owner!=='nxbridge')continue;
    if(existing.some(value=>value.identity.pid===proof.pid&&value.identity.startedAt===proof.generation))continue;
    try{
      const identity=await processIdentity(proof.pid);
      if(!matchesProcess({procStart:proof.generation},identity)&&identity.startedAt!==proof.generation)continue;
      if(proof.role==='codex-runtime'&&!/^codex(?:\.exe)?$/i.test(identity.name))throw Error('旧 App Server 进程身份不符');
      if(proof.role==='agy-acp'&&!/^agy(?:\.exe)?$/i.test(identity.name))throw Error('旧 AGY ACP 进程身份不符');
      existing.push(await recordOwnedProcess(home,{role:proof.role,identity,peerId:proof.peerId,sessionId:proof.sessionId,configHome:proof.configHome,proof:{kind:proof.source==='runtime'?'legacy-runtime':'legacy-ledger'}}));
    }catch(error){if((error as {code?:string}).code!=='process_missing')notes.push(`旧进程 ${proof.pid} 归属迁移未完成：${describeError(error)}`);}
  }
  if(!notes.length)store.setSetting('ownedProcessMigrationComplete',true);
  return notes;
}
