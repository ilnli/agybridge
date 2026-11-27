import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../../shared/errors.js';
import { agyAppDataDirs, agyHome, findAgySessionAppDataDirs, resolveAgyAppDataDir } from '../../shared/local-paths.js';
import type { Actor, Endpoint, RegisterInput } from '../../types.js';

export interface AgyCandidateParent {
  sessionId:string;
  artifactsDir?:string;
}

export interface AgySubagentLineage {
  isSubagent:boolean;
  parentId?:string;
}

export function agyArtifactsDir(configHome:string,conversationId:string):string{
  return path.join(resolveAgyAppDataDir(configHome,conversationId),'brain',conversationId);
}

function transcriptIn(artifactsDir:string):string{
  return path.join(artifactsDir,'.system_generated','logs','transcript_full.jsonl');
}

export function agyTranscriptPath(configHome:string,conversationId:string):string{
  return transcriptIn(agyArtifactsDir(configHome,conversationId));
}

export function mergeAgyNativeSession(previous:Endpoint['nativeSession'],input:RegisterInput):Endpoint['nativeSession']{
  const incoming=input.endpoint.nativeSession;
  if(!incoming)return previous;
  const session={...previous,...incoming};
  if(input.artifactsDirFallback&&previous?.artifactsDir)session.artifactsDir=previous.artifactsDir;
  if(input.transcriptPathFallback!==undefined)session.transcriptPathFallback=input.transcriptPathFallback;
  if(input.transcriptPathFallback){
    const previousDir=previous?.artifactsDir??agyArtifactsDir(input.endpoint.configHome??agyHome(),input.sessionId);
    // Records from older versions have no flag. Keep a nonstandard transcript as host-supplied.
    const reported=previous?.transcriptPathFallback===undefined
      ?previous?.transcriptPath!==transcriptIn(previousDir)
      :!previous.transcriptPathFallback;
    if(previous?.transcriptPath&&reported){
      session.transcriptPath=previous.transcriptPath;
      session.transcriptPathFallback=false;
    }else if(session.artifactsDir)session.transcriptPath=transcriptIn(session.artifactsDir);
  }
  return session;
}

export function agySessionExists(configHome:string,conversationId:string):boolean{
  const matches=findAgySessionAppDataDirs(configHome,conversationId);
  if(matches.length>1)throw new BridgeError('session_store_ambiguous','多个 AGY 数据目录包含该会话，无法核验原始来源。');
  return matches.length===1;
}

function nonEmptyString(value:unknown):string|undefined{
  return typeof value==='string'&&value.length>0?value:undefined;
}

export function agyInputSubagentLineage(input:Record<string,unknown>,conversationId:string):{parentId?:string}|undefined{
  const parentId=nonEmptyString(input.parentConversationId)??nonEmptyString(input.parent_conversation_id);
  if(parentId&&parentId!==conversationId)return{parentId};
  const rootId=nonEmptyString(input.rootConversationId)??nonEmptyString(input.root_conversation_id);
  if(rootId&&rootId!==conversationId)return{parentId:rootId};
  if(input.startedByAgent===true||input.started_by_agent===true||Boolean(nonEmptyString(input.agentName)??nonEmptyString(input.agent_name)))return{};
  return undefined;
}

function inspectTranscriptHead(file:string,conversationId:string):AgySubagentLineage|undefined{
  if(!existsSync(file))return undefined;
  let fd:number|undefined;
  try{
    fd=openSync(file,'r');
    const buf=Buffer.allocUnsafe(8192);
    const bytes=readSync(fd,buf,0,buf.length,0);
    if(bytes<=0)return undefined;
    const text=buf.subarray(0,bytes).toString('utf8');
    const lines=bytes===buf.length?text.slice(0,Math.max(0,text.lastIndexOf('\n'))).split('\n'):text.split('\n');
    for(const raw of lines){
      const line=raw.trim();
      if(!line)continue;
      let step:Record<string,unknown>;
      try{step=JSON.parse(line) as Record<string,unknown>;}catch{continue;}
      if(step.source==='USER_EXPLICIT')return{isSubagent:false};
      if(step.source==='SYSTEM'&&typeof step.content==='string'){
        const match=/\[Message\]\s+timestamp=\S+\s+sender=([\w-]+)\b/.exec(step.content);
        if(match?.[1]&&match[1]!==conversationId)return{isSubagent:true,parentId:match[1]};
      }
    }
  }catch{
    return undefined;
  }finally{
    if(fd!==undefined)try{closeSync(fd);}catch{}
  }
  return undefined;
}

export function detectAgySubagentLineage(options:{
  conversationId:string;
  configHome?:string;
  transcriptPath?:string;
  candidates?:readonly AgyCandidateParent[];
}):AgySubagentLineage|undefined{
  const {conversationId}=options;
  if(!/^[\w-]+$/.test(conversationId))return undefined;
  const configHome=options.configHome??agyHome();
  for(const candidate of options.candidates??[]){
    if(!candidate.sessionId||candidate.sessionId===conversationId)continue;
    const dir=candidate.artifactsDir??agyArtifactsDir(configHome,candidate.sessionId);
    if(existsSync(path.join(dir,'.system_generated','subagents',`${conversationId}.json`))){
      return{isSubagent:true,parentId:candidate.sessionId};
    }
  }
  const transcriptFiles=new Set<string>();
  if(options.transcriptPath){
    if(path.basename(options.transcriptPath)==='transcript_full.jsonl'){
      transcriptFiles.add(path.join(path.dirname(options.transcriptPath),'transcript.jsonl'));
    }
    transcriptFiles.add(options.transcriptPath);
  }
  const defaultLogsDir=path.join(agyArtifactsDir(configHome,conversationId),'.system_generated','logs');
  transcriptFiles.add(path.join(defaultLogsDir,'transcript.jsonl'));
  transcriptFiles.add(path.join(defaultLogsDir,'transcript_full.jsonl'));
  for(const file of transcriptFiles){
    const fromTranscript=inspectTranscriptHead(file,conversationId);
    if(fromTranscript)return fromTranscript;
  }
  for(const dir of new Set([resolveAgyAppDataDir(configHome,conversationId),...agyAppDataDirs(configHome)])){
    const summariesDb=path.join(dir,'conversation_summaries.db');
    if(!existsSync(summariesDb))continue;
    let db:DatabaseSync|undefined;
    try{
      const {DatabaseSync:SqliteDb}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
      db=new SqliteDb(summariesDb,{open:true,readOnly:true});
      const row=db.prepare('SELECT parent_conversation_id,agent_name,nesting_depth FROM conversation_summaries WHERE conversation_id=?').get(conversationId) as {parent_conversation_id?:unknown;agent_name?:unknown;nesting_depth?:unknown}|undefined;
      if(row){
        const parentId=nonEmptyString(row.parent_conversation_id);
        if(parentId&&parentId!==conversationId)return{isSubagent:true,parentId};
        if(Number(row.nesting_depth)>0||nonEmptyString(row.agent_name))return{isSubagent:true};
        return{isSubagent:false};
      }
    }catch{
      continue;
    }finally{
      try{db?.close();}catch{}
    }
  }
  return undefined;
}

export function agyMcpIdentity(
  meta:Record<string,unknown>,
  cwd=process.cwd(),
  runtime:{pid:number;procStart:string;acp?:boolean}={pid:process.ppid,procStart:''},
  configHome=agyHome(),
):{actor:Actor;registration:RegisterInput}{
  const conversationId=typeof meta['antigravity.google/conversation_id']==='string'&&meta['antigravity.google/conversation_id']
    ?meta['antigravity.google/conversation_id']
    :typeof meta.conversationId==='string'&&meta.conversationId
      ?meta.conversationId
      :typeof meta.sessionId==='string'&&meta.sessionId
        ?meta.sessionId
        :undefined;
  if(!conversationId)throw new BridgeError('unverified_identity','宿主未提供有效的 AGY conversation_id。');
  const rootId=typeof meta['antigravity.google/root_conversation_id']==='string'&&meta['antigravity.google/root_conversation_id']
    ?meta['antigravity.google/root_conversation_id']
    :conversationId;
  const reportedDir=meta['antigravity.google/artifacts_dir'];
  const artifactsDirFallback=typeof reportedDir!=='string'||!reportedDir;
  const artifactsDir=artifactsDirFallback?agyArtifactsDir(configHome,conversationId):reportedDir;
  const isSubagent=rootId!==conversationId;
  const mode=runtime.acp?'agy-acp':'agy-tui';
  const transcriptPath=transcriptIn(artifactsDir);
  return{
    actor:{
      host:'agy',
      sessionId:conversationId,
      callId:typeof meta.callId==='string'?meta.callId:randomUUID(),
      ...(isSubagent?{via:conversationId}:{}),
    },
    registration:{
      host:'agy',
      sessionId:conversationId,
      cwd,
      name:'AGY',
      kind:isSubagent?'subagent':'root',
      ...(isSubagent?{parentId:rootId}:{}),
      permission:'unknown',
      replyContract:1,
      artifactsDirFallback,transcriptPathFallback:true,
      endpoint:{
        mode,
        address:'',
        epoch:`${mode}:${runtime.pid}:${runtime.procStart}:${conversationId}`,
        pid:runtime.pid,
        procStart:runtime.procStart,
        configHome,
        questionSupport:true,
        processKind:runtime.acp?'app-server':'foreground',
        nativeSession:{transcriptPath,artifactsDir,interactive:!runtime.acp},
      },
    },
  };
}

export function agyHookRegistration(
  input:Record<string,unknown>,
  runtime:{pid:number;procStart:string;acp?:boolean;cwd?:string},
  configHome=agyHome(),
):RegisterInput{
  const conversationId=typeof input.conversationId==='string'&&input.conversationId
    ?input.conversationId
    :typeof input.session_id==='string'&&input.session_id
      ?input.session_id
      :undefined;
  if(!conversationId)throw new BridgeError('unverified_identity','AGY hook 缺少 conversationId。');
  const workspaces=Array.isArray(input.workspacePaths)?input.workspacePaths.filter((item):item is string=>typeof item==='string'&&item.length>0):[];
  const cwd=(runtime.cwd&&path.isAbsolute(runtime.cwd)?runtime.cwd:undefined)
    ??(typeof input.cwd==='string'&&input.cwd&&workspaces.length===0?input.cwd:workspaces[0]??(typeof input.cwd==='string'&&input.cwd?input.cwd:process.cwd()));
  const reportedDir=input.artifactDirectoryPath;
  const artifactsDirFallback=typeof reportedDir!=='string'||!reportedDir;
  const artifactsDir=artifactsDirFallback?agyArtifactsDir(configHome,conversationId):reportedDir;
  const reportedTranscript=input.transcriptPath;
  const transcriptPathFallback=typeof reportedTranscript!=='string'||!reportedTranscript;
  const transcriptPath=transcriptPathFallback?transcriptIn(artifactsDir):reportedTranscript;
  const model=typeof input.modelName==='string'&&input.modelName?input.modelName:undefined;
  const subagent=agyInputSubagentLineage(input,conversationId);
  const mode=runtime.acp?'agy-acp':'agy-tui';
  return{
    host:'agy',
    sessionId:conversationId,
    cwd,
    name:'AGY',
    kind:subagent?'subagent':'root',
    ...(subagent?.parentId?{parentId:subagent.parentId}:{}),
    permission:'unknown',
    ...(model?{model}:{}),
    replyContract:1,
    artifactsDirFallback,transcriptPathFallback,
    endpoint:{
      mode,
      address:'',
      epoch:`${mode}:${runtime.pid}:${runtime.procStart}:${conversationId}`,
      pid:runtime.pid,
      procStart:runtime.procStart,
      configHome,
      questionSupport:true,
      processKind:runtime.acp?'app-server':'foreground',
      nativeSession:{transcriptPath,artifactsDir,interactive:!runtime.acp},
    },
  };
}
