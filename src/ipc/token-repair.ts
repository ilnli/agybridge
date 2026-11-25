import {randomBytes} from 'node:crypto';
import net from 'node:net';
import type {StartupReservation} from '../broker/broker-startup.js';
import {ownedProcesses,ownedRecordPredatesBoot} from '../process/owned-processes.js';
import {ownedProcessState,stopOwnedProcess} from '../process/process-stop.js';
import {BridgeError} from '../shared/errors.js';
import {ipcAddress} from '../shared/local-paths.js';
import {atomicWriteText} from '../storage/atomic-file.js';
import {delay} from '../shared/time.js';
import {ipcToken,ipcTokenFile} from './token.js';

function invalidToken(home:string):boolean{
  try{ipcToken(home);return false;}catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if(code==='ENOENT')return false;
    if(code==='ipc_token_invalid')return true;
    throw error;
  }
}

function listening(address:string):Promise<boolean>{
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(address);
    socket.once('connect',()=>{socket.destroy();resolve(true);});
    socket.once('error',(error:NodeJS.ErrnoException)=>{if(['ENOENT','ECONNREFUSED'].includes(error.code??''))resolve(false);else reject(error);});
    socket.setTimeout(1000,()=>{
      socket.destroy();reject(new BridgeError('ipc_token_repair_blocked','无法确认旧的 agybridge 后台是否已经退出。请重启电脑后，再运行同样的命令。'));
    });
  });
}

async function assertNoAgyWorker(home:string):Promise<void>{
  for(const record of ownedProcesses(home).records){
    if(record.role!=='agy-acp'||(process.platform==='linux'&&ownedRecordPredatesBoot(record)))continue;
    if(await ownedProcessState(record.identity)!=='dead')throw new BridgeError('ipc_token_repair_blocked','本地 IPC 令牌已损坏。请先等待后台 AGY 进程退出，再运行同样的命令。');
  }
}

async function repairableBroker(home:string):Promise<{pid:number;startedAt:string}|undefined>{
  const blocked=()=>new BridgeError('ipc_token_repair_blocked','本地 IPC 令牌已损坏，无法核验旧协调器的归属。请重启电脑后，再运行同样的命令。');
  const candidates=new Map<string,{pid:number;startedAt:string}>();
  for(const record of ownedProcesses(home).records.filter(value=>value.role==='broker'&&(process.platform!=='linux'||!ownedRecordPredatesBoot(value)))){
    const state=await ownedProcessState(record.identity);
    if(state==='dead')continue;
    if(state==='unknown'||record.releasedToUser)throw blocked();
    const {pid,startedAt}=record.identity;candidates.set(pid+':'+startedAt,{pid,startedAt});
  }
  if(candidates.size>1||!candidates.size&&await listening(ipcAddress(home)))throw blocked();
  return candidates.values().next().value;
}

export async function preflightIpcTokenRepair(home:string):Promise<boolean>{
  if(!invalidToken(home))return false;
  await assertNoAgyWorker(home);
  await repairableBroker(home);
  return true;
}

export async function repairIpcToken(home:string,startup:StartupReservation):Promise<boolean>{
  if(!invalidToken(home))return false;
  await assertNoAgyWorker(home);
  const broker=await repairableBroker(home);
  await startup.assertCurrent();
  const stoppingDeadline=performance.now()+15000;
  if(broker)await stopOwnedProcess(broker,{timeout:15000});

  while(await listening(ipcAddress(home))){
    const remaining=stoppingDeadline-performance.now();
    if(!broker||remaining<=0)throw new BridgeError('ipc_token_repair_blocked','旧协调器仍在监听，本地 IPC 令牌没有更换。请重启电脑后，再运行同样的命令。');
    await delay(Math.min(50,remaining));
  }
  await assertNoAgyWorker(home);
  await startup.assertCurrent();
  if(!invalidToken(home))return false;
  atomicWriteText(ipcTokenFile(home),randomBytes(32).toString('hex'));
  return true;
}
