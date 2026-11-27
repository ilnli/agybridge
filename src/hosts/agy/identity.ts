import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../../shared/errors.js';
import { agyAppDataDir, agyHome } from '../../shared/local-paths.js';
import type { Actor, Endpoint, RegisterInput } from '../../types.js';

export function agyArtifactsDir(configHome:string,conversationId:string):string{
  return path.join(agyAppDataDir(configHome),'brain',conversationId);
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
  const appData=agyAppDataDir(configHome);
  return existsSync(path.join(appData,'conversations',conversationId+'.pb'))||existsSync(path.join(appData,'brain',conversationId));
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
  const mode=runtime.acp?'agy-acp':'agy-tui';
  return{
    host:'agy',
    sessionId:conversationId,
    cwd,
    name:'AGY',
    kind:'root',
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
