import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { BridgeError, DeliveryError, describeError } from '../../shared/errors.js';
import { sameDirectory } from '../../shared/files.js';
import { agyAppDataDir, agyHome, findAgySessionAppDataDirs, resolveAgyAppDataDir } from '../../shared/local-paths.js';
import { prepareOwnedLaunch, recordHostLaunch, selectHostLaunch, spawnSelectedHost } from '../host-launch.js';
import { installedEntry } from '../../install/runtime-install.js';
import { probeProcesses } from '../../process/process.js';
import { ownedProcesses, releaseOwnedProcess, rememberOwnedChild } from '../../process/owned-processes.js';
import type { BridgeConfig, DeliveryResult, Endpoint, ModelProfile, Peer, PermissionClass, RegisterInput } from '../../types.js';
import type { DeliveryMessage } from '../../broker/delivery/file-references.js';
import type { RuntimeAvailability } from '../../broker/health/contracts.js';
import type { TurnHealth } from '../../broker/health/turn-health.js';
import type { EffectiveModelProfile } from '../../broker/profiles/partner-profile.js';
import { AcpClient, type AcpConfigOption, type AcpPermissionOutcome, type AcpPermissionRequest, type AcpSessionResult } from './acp-client.js';

interface ManagedAgySession {
  peerId:string;
  sessionId:string;
  configHome:string;
  appDataDir:string;
  cwd:string;
  client:AcpClient;
  pid:number;
  procStart:string;
  epoch:string;
  permission:PermissionClass;
  mode?:string;
  advertised:AcpSessionResult;
  model?:string;
  effort?:string|number;
  inFlightTurn?:string;
  cancelledTurn?:string;
  health?:TurnHealth;
  tools:Map<string,string>;
  pendingPermissions:Map<string,{cancel:()=>void}>;
}

const AGY_ACP_SYSTEM_APPEND='You are running as a background Antigravity (AGY) partner in agybridge paired with Codex. Reply to partner messages via the codex MCP tools (mcp_codex_send_message / mcp_codex_answer_question) and include in_reply_to when answering a Codex task message. Do not call wait_partner in background mode.';

function extractProfile(result:AcpSessionResult|undefined):{model?:string;effort?:string|number}{
  const options=result?.configOptions??[];
  const modelOpt=options.find(opt=>opt.id==='model'||opt.category==='model');
  const effortOpt=options.find(opt=>opt.id==='thought_level'||opt.id==='reasoning_effort'||opt.category==='thought_level');
  const model=modelOpt?.currentValue??result?.models?.currentModelId;
  const effort=effortOpt?.currentValue;
  return{...(model?{model}:{}),...(effort!==undefined?{effort}:{})};
}

function observedMode(result:AcpSessionResult):string|undefined{
  return result.configOptions?.find(option=>option.id==='mode'||option.category==='mode')?.currentValue??result.modes?.currentModeId;
}

function sessionAppDataDir(home:string,sessionId:string,endpoint?:Endpoint):string{
  const matches=findAgySessionAppDataDirs(home,sessionId);
  if(matches.length===1)return matches[0]!;
  if(!matches.length)return resolveAgyAppDataDir(home);
  const native=endpoint?.nativeSession;
  if(endpoint?.configHome&&sameDirectory(endpoint.configHome,home)&&native?.transcriptPathFallback===false&&native.transcriptPath){
    const selected=matches.filter(dir=>['transcript_full.jsonl','transcript.jsonl'].some(file=>sameDirectory(native.transcriptPath!,path.join(dir,'brain',sessionId,'.system_generated','logs',file))));
    if(selected.length===1)return selected[0]!;
  }
  throw new BridgeError('agy_session_ambiguous','多个 AGY 数据目录含有相同会话，无法确认原始会话所在目录。');
}

async function applyMode(client:AcpClient,sessionId:string,mode:string|undefined,advertised:AcpSessionResult,current=observedMode(advertised)):Promise<string|undefined>{
  if(!mode||mode===current)return current;
  const option=advertised.configOptions?.find(value=>value.id==='mode'||value.category==='mode');
  if(option?.options?.some(choice=>choice.value===mode)){
    return observedMode(await client.setConfigOption(sessionId,option.id,mode))??mode;
  }
  if(advertised.modes?.availableModes?.some(value=>value.id===mode)){
    return observedMode(await client.setMode(sessionId,mode))??mode;
  }
  throw new BridgeError('agy_mode_unsupported','AGY 会话没有提供所请求的模式：'+mode);
}

function formatPartnerEnvelope(message:DeliveryMessage,sender:Peer):string{
  if(message.notice){
    return message.body;
  }
  const attrs=[
    `message_id="${message.id}"`,
    `from="${sender.host}"`,
    `from_name="${sender.name.replaceAll('"','\'')}"`,
    ...(message.inReplyTo?[`in_reply_to="${message.inReplyTo}"`]:[]),
    ...(message.replyExpected?['reply_expected="true"']:[]),
    ...(message.via?[`via="${message.via}"`]:[]),
  ].join(' ');
  return `<partner-message ${attrs}>\n${message.body}\n</partner-message>`;
}

export class AgyAdapter extends EventEmitter {
  private sessions=new Map<string,ManagedAgySession>();
  modelProfile?:(peer:Peer)=>ModelProfile;
  constructor(private config:BridgeConfig,private home:string){super();}

  private sessionByPeer(peerId:string):ManagedAgySession|undefined{
    const session=this.sessions.get(peerId);
    return session?.client.isClosed?undefined:session;
  }

  healthOf(peerId:string):TurnHealth|undefined{
    return this.sessionByPeer(peerId)?.health;
  }

  private acpMcpServers(configHome:string):unknown[]{
    const runtime=installedEntry(this.home);
    const env:[{name:string;value:string},...{name:string;value:string}[]]=[{name:'AGYBRIDGE_HOME',value:this.home}];
    const defaultGemini=path.join(homedir(),'.gemini');
    if(!sameDirectory(configHome,defaultGemini))env.push({name:'AGY_HOME',value:configHome});
    return[{
      name:'codex',
      command:runtime.node,
      args:['--no-warnings',runtime.entry,'mcp','--host','agy'],
      env,
    }];
  }

  private acpArgs(configHome:string,permission:PermissionClass,appDataDir?:string):string[]{
    const args=['acp','--stdio'];
    if(permission==='bypass')args.push('--dangerously-skip-permissions');
    const defaultGemini=path.join(homedir(),'.gemini');
    if(!sameDirectory(configHome,defaultGemini)){
      args.push('--gemini-dir',configHome);
    }
    if(appDataDir&&!sameDirectory(appDataDir,agyAppDataDir(configHome)))args.push('--app-data-dir',appDataDir);
    return args;
  }

  private async spawnClient(peer:Peer,configHome:string|undefined,permission:PermissionClass,affinity?:{executable?:string;profileId?:string},resume?:{sessionId:string;endpoint?:Endpoint}){
    const selected=selectHostLaunch('agy',this.config,{
      home:this.home,
      cwd:peer.cwd,
      ...(configHome?{configHome}:{}),
      ...(affinity?.executable?{executable:affinity.executable}:{}),
      ...(affinity?.profileId?{profileId:affinity.profileId}:{}),
    });
    if(resume&&configHome&&!sameDirectory(configHome,selected.configHome))throw new BridgeError('original_home_changed','AGY 启动配置目录与原会话不同。');
    const launch=await prepareOwnedLaunch(selected);
    const launchId=randomUUID();
    const appDataDir=resume?sessionAppDataDir(launch.configHome,resume.sessionId,resume.endpoint):agyAppDataDir(launch.configHome);
    const args=this.acpArgs(launch.configHome,permission,appDataDir);
    const child=spawnSelectedHost(launch,args,{stdio:['pipe','pipe','pipe']}) as ChildProcessWithoutNullStreams;
    const client:AcpClient=new AcpClient(child,params=>this.handlePermission(peer.id,client,params));
    try{
      await once(child,'spawn');
      if(!child.pid)throw new BridgeError('agy_launch_failed','无法获取后台 AGY ACP 进程 PID。');
      const record=await rememberOwnedChild(this.home,child,'agy-acp',{peerId:peer.id,sessionId:peer.sessionId??undefined,configHome:launch.configHome},launchId);
      if(!record)throw new BridgeError('agy_launch_failed','后台 AGY ACP 在启动登记完成前退出。');
      recordHostLaunch(this.home,'agy-acp',launch,child.pid);
      return{client,pid:child.pid,procStart:record.identity.startedAt,configHome:launch.configHome,appDataDir,launchId};
    }catch(error){
      client.close();
      throw error;
    }
  }

  private async handlePermission(peerId:string,client:AcpClient,params:AcpPermissionRequest):Promise<AcpPermissionOutcome>{
    const session=this.sessions.get(peerId);
    const cancelled={outcome:{outcome:'cancelled'}} as const;
    if(!session||session.client!==client||client.isClosed||params.sessionId!==session.sessionId||!session.inFlightTurn||session.cancelledTurn===session.inFlightTurn)return cancelled;
    if(session.permission==='bypass'){
      const allow=params.options?.find(option=>option.kind==='allow_once')??params.options?.find(option=>option.kind==='allow_always');
      return allow?{outcome:{outcome:'selected',optionId:allow.optionId}}:cancelled;
    }
    const health=session.health;
    if(!health)return cancelled;
    const request={id:randomUUID(),method:'session/request_permission',itemId:params.toolCall?.toolCallId,kind:'permission',title:String(params.toolCall?.title??params.toolCall?.kind??'permission')};
    return new Promise(resolve=>{
      const cancel=()=>{
        clearTimeout(timer);
        session.pendingPermissions.delete(request.id);
        health.humanRequests=health.humanRequests?.filter(value=>value.id!==request.id);
        if(!health.humanRequests?.length){
          delete health.humanRequests;
          health.state=session.tools.size?'waitingTool':'running';
          if(this.sessionByPeer(peerId)===session&&session.inFlightTurn&&session.cancelledTurn!==session.inFlightTurn)this.emit('state',session.sessionId,'busy');
        }
        resolve(cancelled);
      };
      const timer=setTimeout(cancel,this.config.questionTimeoutMs??600000);
      timer.unref();
      session.pendingPermissions.set(request.id,{cancel});
      health.humanRequests=[...(health.humanRequests??[]),request];
      health.state='needsHuman';health.lastEventAt=Date.now();
      this.emit('state',session.sessionId,'needsHuman');
      this.emit('diagnostic',`AGY ACP 等待权限确认：${request.title}`);
    });
  }

  private cancelPermissions(session:ManagedAgySession):void{
    session.cancelledTurn=session.inFlightTurn;
    for(const request of session.pendingPermissions.values())request.cancel();
  }

  private wireSession(session:ManagedAgySession):void{
    const {client,peerId,sessionId}=session;
    client.on('update',(params:any)=>{
      const update=params?.update;
      if(!update||typeof update!=='object'||params.sessionId!==sessionId||this.sessions.get(peerId)!==session)return;
      const now=Date.now();
      if(session.health){
        session.health.lastEventAt=now;
        session.health.lastProgressAt=now;
      }
      const kind=update.sessionUpdate;
      if(kind==='tool_call'){
        const id=String(update.toolCallId??update.id??randomUUID());
        const name=String(update.title??update.name??'tool');
        session.tools.set(id,name);
        if(session.health){
          session.health.tools=[...session.tools.values()];
          if(!session.pendingPermissions.size)session.health.state='waitingTool';
        }
      }else if(kind==='tool_call_update'&&(update.status==='completed'||update.status==='failed')){
        if(update.toolCallId)session.tools.delete(String(update.toolCallId));
        if(session.health){
          session.health.tools=[...session.tools.values()];
          if(!session.tools.size&&session.inFlightTurn&&!session.pendingPermissions.size)session.health.state='running';
        }
      }else if(kind==='config_option_update'&&Array.isArray(update.configOptions)){
        session.advertised.configOptions=update.configOptions;
        const profile=extractProfile({configOptions:update.configOptions as AcpConfigOption[]});
        if(profile.model)session.model=profile.model;
        if(profile.effort!==undefined)session.effort=profile.effort;
        this.emit('profile',sessionId,{model:session.model,effort:session.effort});
      }else if(kind==='usage_update'&&typeof update.used==='number'&&Number.isFinite(update.used)){
        this.emit('usage',sessionId,{tokens:Math.round(update.used),at:now});
      }
      const mode=kind==='config_option_update'&&Array.isArray(update.configOptions)?observedMode(update):kind==='current_mode_update'?update.currentModeId:undefined;
      if(typeof mode==='string'&&mode&&mode!==session.mode){
        session.mode=mode;
        this.emit('permission',sessionId,session.permission,mode);
      }
    });
    client.once('exit',()=>{
      this.cancelPermissions(session);
      if(this.sessions.get(peerId)===session){
        this.sessions.delete(peerId);
        this.emit('state',sessionId,'offline');
        this.emit('disconnected',session.epoch);
      }
    });
  }

  private async applyProfile(client:AcpClient,sessionId:string,profile?:ModelProfile):Promise<{model?:string;effort?:string|number}>{
    if(!profile)return{};
    let latest:AcpConfigOption[]|undefined;
    if(profile.model!==undefined){
      const result=await client.setConfigOption(sessionId,'model',profile.model);
      latest=result.configOptions??latest;
    }
    if(profile.effort!==undefined){
      const result=await client.setConfigOption(sessionId,'thought_level',String(profile.effort));
      latest=result.configOptions??latest;
    }
    return extractProfile({configOptions:latest});
  }

  private registrationFor(session:ManagedAgySession):RegisterInput{
    const artifactsDir=path.join(session.appDataDir,'brain',session.sessionId);
    return{
      host:'agy',
      sessionId:session.sessionId,
      cwd:session.cwd,
      name:'AGY',
      kind:'root',
      permission:session.permission,
      state:session.pendingPermissions.size?'needsHuman':session.inFlightTurn?'busy':'ready',
      ...(session.model?{model:session.model}:{}),
      ...(session.effort!==undefined?{effort:session.effort}:{}),
      replyContract:1,
      artifactsDirFallback:true,
      transcriptPathFallback:true,
      endpoint:{
        mode:'agy-acp',
        address:`acp:${session.pid}:${session.sessionId}`,
        epoch:session.epoch,
        pid:session.pid,
        procStart:session.procStart,
        configHome:session.configHome,
        questionSupport:true,
        processKind:'app-server',
        nativePermission:{permission:session.permission,...(session.mode?{mode:session.mode}:{}),observedAt:Date.now()},
        nativeSession:{artifactsDir,transcriptPath:path.join(artifactsDir,'.system_generated','logs','transcript_full.jsonl'),transcriptPathFallback:true,interactive:false},
      },
    };
  }

  async create(
    peer:Peer,
    guard?:()=>void,
    sourcePermission:PermissionClass='bypass',
    beforeCreate?:()=>void|Promise<void>,
    profile?:ModelProfile,
    mode?:string,
  ):Promise<RegisterInput>{
    guard?.();
    await beforeCreate?.();
    const permission=sourcePermission==='bypass'?'bypass':sourcePermission==='prompting'?'prompting':'unknown';
    const spawned=await this.spawnClient(peer,undefined,permission);
    try{
      guard?.();
      await spawned.client.initialize();
      const created=await spawned.client.newSession({
        cwd:peer.cwd,
        mcpServers:this.acpMcpServers(spawned.configHome),
        _meta:{systemPrompt:{append:AGY_ACP_SYSTEM_APPEND}},
      });
      if(!created.sessionId)throw new BridgeError('agy_launch_failed','AGY ACP 未返回有效的 sessionId。');
      const requested=profile??this.modelProfile?.(peer);
      const applied=requested&&(requested.model!==undefined||requested.effort!==undefined)
        ?await this.applyProfile(spawned.client,created.sessionId,requested)
        :{};
      const initial=extractProfile(created);
      const session:ManagedAgySession={
        peerId:peer.id,
        sessionId:created.sessionId,
        configHome:spawned.configHome,
        appDataDir:spawned.appDataDir,
        cwd:peer.cwd,
        client:spawned.client,
        pid:spawned.pid,
        procStart:spawned.procStart,
        epoch:`agy-acp:${spawned.pid}:${spawned.procStart}:${created.sessionId}`,
        permission,
        advertised:created,
        mode:await applyMode(spawned.client,created.sessionId,mode,created),
        model:applied.model??initial.model,
        effort:applied.effort??initial.effort,
        tools:new Map(),
        pendingPermissions:new Map(),
      };
      this.sessions.set(peer.id,session);
      this.wireSession(session);
      return this.registrationFor(session);
    }catch(error){
      spawned.client.close();
      throw error;
    }
  }

  async wake(
    peer:Peer,
    endpoint?:Endpoint,
    guard?:()=>void,
    beforeLaunch?:()=>void|Promise<void>,
    affinity?:{configHome?:string;executable?:string;profileId?:string},
    mode?:string,
  ):Promise<RegisterInput>{
    if(!peer.sessionId)throw new BridgeError('session_missing','AGY 成员没有可恢复的会话 ID。');
    const existing=this.sessionByPeer(peer.id);
    if(existing&&existing.sessionId===peer.sessionId&&!existing.client.isClosed){
      if(existing.permission!==peer.permission)throw new BridgeError('agy_permission_changed','运行中的 AGY ACP 进程权限与恢复请求不一致。');
      if(mode&&mode!==existing.mode){
        if(existing.inFlightTurn)throw new BridgeError('session_busy','后台 AGY 正在执行轮次，无法切换模式。');
        guard?.();
        existing.mode=await applyMode(existing.client,existing.sessionId,mode,existing.advertised,existing.mode);
      }
      return this.registrationFor(existing);
    }
    guard?.();
    await beforeLaunch?.();
    const spawned=await this.spawnClient(peer,affinity?.configHome??endpoint?.configHome,peer.permission,affinity,{sessionId:peer.sessionId,endpoint});
    try{
      guard?.();
      await spawned.client.initialize();
      const mcpServers=this.acpMcpServers(spawned.configHome);
      let resumed:AcpSessionResult;
      try{
        resumed=await spawned.client.resumeSession({sessionId:peer.sessionId,cwd:peer.cwd,mcpServers,_meta:{systemPrompt:{append:AGY_ACP_SYSTEM_APPEND}}});
      }catch{
        resumed=await spawned.client.loadSession({sessionId:peer.sessionId,cwd:peer.cwd,mcpServers});
      }
      if(resumed.sessionId&&resumed.sessionId!==peer.sessionId)throw new BridgeError('session_changed','AGY ACP 返回了不同的会话 ID。');
      const profile=extractProfile(resumed);
      const session:ManagedAgySession={
        peerId:peer.id,
        sessionId:peer.sessionId,
        configHome:spawned.configHome,
        appDataDir:spawned.appDataDir,
        cwd:peer.cwd,
        client:spawned.client,
        pid:spawned.pid,
        procStart:spawned.procStart,
        epoch:`agy-acp:${spawned.pid}:${spawned.procStart}:${peer.sessionId}`,
        permission:peer.permission,
        advertised:resumed,
        mode:await applyMode(spawned.client,peer.sessionId,mode,resumed),
        model:profile.model??peer.model,
        effort:profile.effort??peer.effort,
        tools:new Map(),
        pendingPermissions:new Map(),
      };
      this.sessions.set(peer.id,session);
      this.wireSession(session);
      return this.registrationFor(session);
    }catch(error){
      spawned.client.close();
      throw error;
    }
  }

  async deliver(peer:Peer,endpoint:Endpoint,message:DeliveryMessage,sender:Peer):Promise<DeliveryResult>{
    if(endpoint.mode!=='agy-acp'){
      return{state:'expired',evidence:'foreground agy-tui uses waiter or hook delivery'};
    }
    const session=this.sessionByPeer(peer.id);
    if(!session||session.sessionId!==peer.sessionId||session.epoch!==endpoint.epoch){
      throw new DeliveryError('agy_acp_offline','后台 AGY ACP 会话未连接。',false);
    }
    if(session.inFlightTurn){
      return{state:'expired',evidence:'agy-acp turn busy; waiting for current turn to finish'};
    }
    if(message.beforeSubmit&&!await message.beforeSubmit()){
      return{state:'expired',evidence:'提交前核验已失效，未发送到 AGY ACP'};
    }
    if(this.sessionByPeer(peer.id)!==session||session.inFlightTurn){
      return{state:'expired',evidence:'提交前 AGY ACP 会话状态已改变'};
    }
    const turnId='acp-'+randomUUID();
    const now=Date.now();
    session.inFlightTurn=turnId;
    session.tools.clear();
    session.health={turnId,state:'running',lastEventAt:now,lastProgressAt:now,tools:[]};
    this.emit('state',session.sessionId,'busy');
    const promptPromise=session.client.prompt(session.sessionId,formatPartnerEnvelope(message,sender));
    void promptPromise.then(result=>{
      if(session.inFlightTurn!==turnId)return;
      this.cancelPermissions(session);
      session.inFlightTurn=undefined;
      session.tools.clear();
      const finishedAt=Date.now();
      session.health={turnId,state:'ready',completion:result?.stopReason??'end_turn',lastEventAt:finishedAt,lastProgressAt:finishedAt,tools:[]};
      if(this.sessions.get(peer.id)!==session)return;
      this.emit('state',session.sessionId,'ready');
      this.emit('turnCompleted',session.sessionId,turnId);
    },error=>{
      if(session.inFlightTurn!==turnId)return;
      this.cancelPermissions(session);
      session.inFlightTurn=undefined;
      session.tools.clear();
      const finishedAt=Date.now();
      session.health={turnId,state:'failed',error:describeError(error),lastEventAt:finishedAt,lastProgressAt:finishedAt,tools:[]};
      if(!session.client.isClosed&&this.sessions.get(peer.id)===session){
        this.emit('state',session.sessionId,'ready');
        this.emit('diagnostic',`AGY ACP turn ${turnId} 失败：${describeError(error)}`);
      }
    });
    return{state:'contextObserved',evidence:`agy-acp session/prompt submitted, session=${session.sessionId}, turn=${turnId}`};
  }

  async setProfile(peer:Peer,endpoint:Endpoint|undefined,profile:ModelProfile,guard?:()=>void):Promise<EffectiveModelProfile>{
    const session=this.sessionByPeer(peer.id);
    if(!session||endpoint&&session.epoch!==endpoint.epoch){
      throw new BridgeError('agy_acp_offline','后台 AGY ACP 会话未运行，稍后重连时应用配置。');
    }
    if(session.inFlightTurn){
      throw new BridgeError('session_busy','后台 AGY 正在执行当前轮次，等待空闲后再切换模型/推理强度。');
    }
    guard?.();
    const applied=await this.applyProfile(session.client,session.sessionId,profile);
    guard?.();
    if(applied.model)session.model=applied.model;
    if(applied.effort!==undefined)session.effort=applied.effort;
    return{...(session.model?{model:session.model}:{}),...(profile.model?{requestedModel:profile.model}:{}),...(session.effort!==undefined?{effort:session.effort}:{})};
  }

  async readProfile(peer:Peer,_endpoint?:Endpoint,guard?:()=>void):Promise<EffectiveModelProfile>{
    guard?.();
    const session=this.sessionByPeer(peer.id);
    if(!session){
      throw new BridgeError('agy_acp_offline','后台 AGY ACP 会话未运行，无法回读模型配置。');
    }
    return{...(session.model?{model:session.model}:{}),...(session.effort!==undefined?{effort:session.effort}:{})};
  }

  async interrupt(peer:Peer):Promise<void>{
    const session=this.sessionByPeer(peer.id);
    if(session){
      this.cancelPermissions(session);
      session.client.cancel(session.sessionId);
    }
  }

  async handoffToForeground(peer:Peer,interrupt=false):Promise<{sessionId:string;configHome:string}>{
    if(!peer.sessionId)throw new BridgeError('session_missing','AGY 成员尚未创建会话。');
    const session=this.sessionByPeer(peer.id);
    if(session){
      if(session.inFlightTurn){
        if(!interrupt)throw new BridgeError('agy_turn_busy','后台 AGY 仍在工作；运行 agybridge open agy --interrupt 先中断再接管。');
        this.cancelPermissions(session);
        session.client.cancel(session.sessionId);
      }
      const configHome=session.configHome;
      await session.client.closeSession(session.sessionId);
      session.client.close();
      this.sessions.delete(peer.id);
      return{sessionId:peer.sessionId,configHome};
    }
    return{sessionId:peer.sessionId,configHome:this.config.agyHome??agyHome()};
  }

  async probe(peer:Peer,endpoint?:Endpoint):Promise<RuntimeAvailability>{
    const checked_at=Date.now();
    if(!endpoint)return{state:peer.sessionId?'blocked':'starting',reasons:[peer.sessionId?'no active endpoint':'partner starting'],checked_at};
    if(endpoint.mode==='agy-acp'){
      const session=this.sessionByPeer(peer.id);
      if(session&&!session.client.isClosed&&session.epoch===endpoint.epoch){
        return{state:'reachable',reasons:[],checked_at,nativeState:'alive'};
      }
      if(endpoint.pid&&endpoint.procStart){
        const state=(await probeProcesses([{pid:endpoint.pid,procStart:endpoint.procStart}]))[0]??'unknown';
        return{state:state==='alive'?'reachable':state==='dead'?'blocked':'unknown',reasons:state==='alive'?[]:['agy-acp process '+state],checked_at,nativeState:state};
      }
      return{state:'blocked',reasons:['agy-acp session disconnected'],checked_at,nativeState:'dead'};
    }
    if(endpoint.pid&&endpoint.procStart){
      const state=(await probeProcesses([{pid:endpoint.pid,procStart:endpoint.procStart}]))[0]??'unknown';
      return{state:state==='alive'?'reachable':state==='dead'?'blocked':'unknown',reasons:state==='alive'?[]:['agy-tui process '+state],checked_at,nativeState:state};
    }
    return{state:'unknown',reasons:['agy process identity unavailable'],checked_at,nativeState:'unknown'};
  }

  setEnabled(peer:Peer,_endpoint:Endpoint|undefined,enabled:boolean):void{
    if(!enabled)void this.interrupt(peer);
  }

  async release(peer:Peer):Promise<void>{
    const session=this.sessions.get(peer.id);
    if(session){
      this.sessions.delete(peer.id);
      this.cancelPermissions(session);
      await session.client.closeSession(session.sessionId);
      session.client.close();
    }
    for(const record of ownedProcesses(this.home).records.filter(r=>r.peerId===peer.id&&r.role==='agy-acp'&&!r.releasedToUser)){
      await releaseOwnedProcess(record);
    }
  }

  close():void{
    for(const session of this.sessions.values()){
      this.cancelPermissions(session);
      session.client.close();
    }
    this.sessions.clear();
  }
}
