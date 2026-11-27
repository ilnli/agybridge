const PAIRED_TAG='agybridge:paired';
const DEFAULT_TIMEOUT_MS=800;

export interface AgyLsConnection {
  address:string;
  csrfToken:string;
}

export interface AgyConversationRecord {
  id?:string;
  metadata?:{
    createTime?:string;
    projectId?:string;
    environmentId?:string;
    parentConversationId?:string;
    rootConversationId?:string;
    tags?:string[];
  };
  annotations?:{
    title?:string;
    tags?:string[];
    archived?:boolean;
    pinned?:boolean;
    starred?:boolean;
    conversationGroupId?:string;
  };
  state?:{
    summary?:string;
    runState?:string;
    updateTime?:string;
  };
}

export function parseLocalAgyLsAddress(raw:unknown):string|undefined{
  if(typeof raw!=='string')return undefined;
  const trimmed=raw.trim();
  const match=/^(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})$/i.exec(trimmed);
  if(!match)return undefined;
  const port=Number(match[2]);
  if(!Number.isInteger(port)||port<1||port>65535)return undefined;
  return `${match[1]!.toLowerCase()}:${port}`;
}

export function extractAgyLsConnection(env:NodeJS.ProcessEnv=process.env):AgyLsConnection|undefined{
  const address=parseLocalAgyLsAddress(env.ANTIGRAVITY_LS_ADDRESS);
  const csrfToken=typeof env.ANTIGRAVITY_CSRF_TOKEN==='string'?env.ANTIGRAVITY_CSRF_TOKEN.trim():'';
  if(!address||!csrfToken||csrfToken.length>512)return undefined;
  return{address,csrfToken};
}

async function callConversationService<T>(
  connection:AgyLsConnection,
  method:'GetConversation'|'UpdateConversation',
  body:Record<string,unknown>,
  timeoutMs=DEFAULT_TIMEOUT_MS,
  fetchImpl:typeof fetch=fetch,
):Promise<T|undefined>{
  const address=parseLocalAgyLsAddress(connection.address);
  if(!address||!connection.csrfToken)return undefined;
  try{
    const response=await fetchImpl(`http://${address}/product.v1.ConversationService/${method}`,{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Connect-Protocol-Version':'1',
        'x-antigravity-csrf-token':connection.csrfToken,
      },
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(Math.max(50,timeoutMs)),
    });
    if(!response.ok)return undefined;
    return await response.json() as T;
  }catch{
    return undefined;
  }
}

export async function getAgyConversation(
  connection:AgyLsConnection,
  conversationId:string,
  options:{timeoutMs?:number;fetchImpl?:typeof fetch}={},
):Promise<AgyConversationRecord|undefined>{
  if(!conversationId||!/^[\w-]+$/.test(conversationId))return undefined;
  return callConversationService<AgyConversationRecord>(
    connection,
    'GetConversation',
    {conversationId},
    options.timeoutMs,
    options.fetchImpl,
  );
}

export async function syncAgyConversationPairedTag(
  connection:AgyLsConnection,
  conversationId:string,
  paired:boolean,
  options:{tag?:string;timeoutMs?:number;fetchImpl?:typeof fetch}={},
):Promise<boolean>{
  if(!conversationId||!/^[\w-]+$/.test(conversationId))return false;
  const tag=options.tag??PAIRED_TAG;
  const current=await getAgyConversation(connection,conversationId,options);
  if(!current)return false;
  const existing=Array.isArray(current.annotations?.tags)
    ?current.annotations.tags.filter((item):item is string=>typeof item==='string'&&item.length>0)
    :[];
  const hasTag=existing.includes(tag);
  if(paired&&hasTag)return true;
  if(!paired&&!hasTag)return true;
  const nextTags=paired?[...existing,tag]:existing.filter(item=>item!==tag);
  const updated=await callConversationService<AgyConversationRecord>(
    connection,
    'UpdateConversation',
    {
      conversationId,
      annotations:{tags:nextTags},
      updateMask:'annotations.tags',
    },
    options.timeoutMs,
    options.fetchImpl,
  );
  return Boolean(updated);
}

export class AgyConversationTracker {
  private byProcess=new Map<string,{connection:AgyLsConnection;observedAt:number}>();
  private bySession=new Map<string,{connection:AgyLsConnection;observedAt:number}>();

  observe(input:{pid?:number|null;procStart?:string|null;sessionId?:string|null;ls?:AgyLsConnection|null}):void{
    const address=parseLocalAgyLsAddress(input.ls?.address);
    const csrfToken=typeof input.ls?.csrfToken==='string'?input.ls.csrfToken.trim():'';
    if(!address||!csrfToken)return;
    const entry={connection:{address,csrfToken},observedAt:Date.now()};
    if(input.pid&&input.procStart){
      this.byProcess.set(`${input.pid}:${input.procStart}`,entry);
      if(this.byProcess.size>64)this.byProcess.delete(this.byProcess.keys().next().value!);
    }
    if(input.sessionId){
      this.bySession.set(input.sessionId,entry);
      if(this.bySession.size>128)this.bySession.delete(this.bySession.keys().next().value!);
    }
  }

  connectionFor(lookup:{pid?:number|null;procStart?:string|null;sessionId?:string|null}):AgyLsConnection|undefined{
    if(lookup.pid&&lookup.procStart){
      const hit=this.byProcess.get(`${lookup.pid}:${lookup.procStart}`);
      if(hit)return hit.connection;
    }
    if(lookup.sessionId){
      return this.bySession.get(lookup.sessionId)?.connection;
    }
    return undefined;
  }

  syncPairedBestEffort(
    lookup:{pid?:number|null;procStart?:string|null;sessionId?:string|null},
    paired:boolean,
    options:{timeoutMs?:number;fetchImpl?:typeof fetch}={},
  ):Promise<boolean>{
    const sessionId=lookup.sessionId;
    if(!sessionId)return Promise.resolve(false);
    const connection=this.connectionFor(lookup);
    if(!connection)return Promise.resolve(false);
    return syncAgyConversationPairedTag(connection,sessionId,paired,options).catch(()=>false);
  }
}
