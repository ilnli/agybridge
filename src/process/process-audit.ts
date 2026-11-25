import { ownedProcesses, ownedRecordState, processRegistryRoot } from './owned-processes.js';

export function processOwnershipSummary(home:string){
  const {records,notes}=ownedProcesses(home);
  return{registry:processRegistryRoot(),records:records.map(value=>({pid:value.identity.pid,procStart:value.identity.startedAt,role:value.role,peerId:value.peerId??null,sessionId:value.sessionId??null,releasedToUser:value.releasedToUser??false})),native:[],notes};
}
export async function auditOwnedProcesses(home:string){
  const summary=processOwnershipSummary(home),owned=ownedProcesses(home).records;
  const states=await Promise.all(owned.map(ownedRecordState));
  const records=owned.map((record,index)=>({pid:record.identity.pid,procStart:record.identity.startedAt,role:record.role,state:states[index],releasedToUser:record.releasedToUser??false}));
  return{...summary,records};
}
