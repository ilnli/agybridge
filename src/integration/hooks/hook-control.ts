import { randomUUID } from 'node:crypto';
import { brokerCall as callBroker } from '../../ipc/ipc.js';
import { agyHookRegistration } from '../../hosts/agy/identity.js';
import { agyProcessIdentity, codexProcessIdentity } from '../../process/process.js';
import { codexAgentPath } from '../../hosts/codex/adapter.js';
import { agyHome, bridgeHome, codexHome } from '../../shared/local-paths.js';
import { describeError } from '../../shared/errors.js';
import { isEmbeddedWake, type Actor, type Host } from '../../types.js';
import { hookCommand as runHookCommand } from './hook-command.js';
import { agyControlReply } from './hook-output.js';
import { acknowledgeRuntimeNotice, collectRuntimeNotices } from '../../broker/health/runtime-monitor.js';
import { runtimeNoticeText, type RuntimeNotice } from '../../broker/health/contracts.js';
import { compactedMessageIds } from '../../broker/delivery/compacted-messages.js';
import { remainingTime } from '../../shared/time-budget.js';
import { disabledMember } from '../../broker/member-control.js';
import { formatStatus } from '../mcp/presentation.js';
import { codexHookApproval } from '../../hosts/codex/codex-permission.js';

export interface HookExecution {
  home?:string;configHome?:string;startedAt?:number;deadline?:number;
  agy?:{identity:Awaited<ReturnType<typeof agyProcessIdentity>>;configHome:string;ownedLaunch?:{peerId:string;launchId:string}};
  runtime?:Awaited<ReturnType<typeof codexProcessIdentity>>;identityMs?:number;elapsedMs?:number;
  call?:typeof callBroker;
}

function appendAgySystemMessage(result:any,messages:string[]):Record<string,unknown>{
  const nonEmpty=messages.map(m=>m.trim()).filter(Boolean);
  if(!nonEmpty.length)return result??{};
  const existing=Array.isArray(result?.injectSteps)?result.injectSteps:[];
  return{
    ...(result&&typeof result==='object'?result:{}),
    injectSteps:[...existing,...nonEmpty.map(text=>({systemMessage:{systemMessage:text}}))],
  };
}

export async function hook(host:Host,input:any,provided:(ack:()=>Promise<void>)=>void,execution:HookExecution={}):Promise<unknown>{
  const began=performance.now(),home=execution.home??bridgeHome();
  const inheritedStart=Number(process.env.AGYBRIDGE_HOOK_STARTED_AT),inheritedAge=performance.timeOrigin-inheritedStart,startedAt=execution.startedAt??(Number.isFinite(inheritedStart)&&inheritedAge>=0&&inheritedAge<10000?inheritedStart:performance.timeOrigin);
  const event:string=input.hook_event_name??input.hookEventName??'';
  const sessionId:string=input.session_id??input.conversationId??'';
  const prompt:string|undefined=typeof input.prompt==='string'?input.prompt:typeof input.lastUserInput==='string'?input.lastUserInput:undefined;
  const deadline=execution.deadline??(host==='codex'?(['SessionEnd','Interrupt'].includes(event)?2300:9000)-(performance.timeOrigin-startedAt):undefined);
  const brokerCall=<T=any>(method:string,params:unknown={},options:Parameters<typeof callBroker>[2]={})=>(execution.call??callBroker)<T>(method,params,{...options,deadline});
  const control=(host==='codex'&&event==='UserPromptSubmit'&&!input.agent_id&&!input.agent_transcript_path||host==='agy'&&event==='PreInvocation')&&typeof prompt==='string'
    ?/^\s*agybridge\s+(on|off|status)(?:\s+(self|codex|agy))?\s*$/.exec(prompt)
    :null;
  const agyPreToolFallback=()=>host==='agy'&&event==='PreToolUse'?{decision:'allow'}:{};
  if(!control&&disabledMember(home,{host,sessionId})){input.agybridge_disabled=true;return agyPreToolFallback();}

  if(host==='agy'){
    const configHome=execution.agy?.configHome??execution.configHome??agyHome();
    const identityStartedAt=performance.now();
    const runtime=execution.agy?.identity??await agyProcessIdentity(remainingTime(deadline,5000));
    const identityMs=execution.identityMs??performance.now()-identityStartedAt;
    const disabled=disabledMember(home,{host:'agy',sessionId,pid:runtime.pid,procStart:runtime.procStart,configHome});
    if(disabled){
      input.agybridge_disabled=true;
      if(!control)return agyPreToolFallback();
      const actor:Actor={host:'agy',memberId:disabled.peerId,sessionId:disabled.sessionId!,callId:randomUUID()};
      if(control[1]==='status'){
        const text=formatStatus(await brokerCall('status',{actor},{timeout:8000}))||'agybridge 已关闭。';
        return agyControlReply(text);
      }
      const target=control[2]&&control[2]!=='self'&&control[2]!=='agy'?'partner':'self';
      const result=await brokerCall<any>('member.switch',{actor,target,enabled:control[1]==='on',user_requested:true,origin:'composer'},{mutation:true,timeout:8000});
      return agyControlReply(result.message||'已完成切换。');
    }
    const contextKey=`${runtime.pid}:${runtime.procStart}:${input.transcriptPath??sessionId}`;
    const registrationStartedAt=performance.now();
    let actor:Actor|undefined;
    try{
      if(['SessionStart','PreInvocation'].includes(event)&&sessionId){
        const registration=agyHookRegistration(input,runtime,configHome);
        registration.hookContextKey=contextKey;
        registration.contextStart=event==='SessionStart';
        registration.contextReason='unknown';
        registration.boundaryStartedAt=startedAt;
        const registered=await brokerCall<{id?:string;binding?:Actor['binding']}>('mcp.register',registration,{start:event==='SessionStart'||event==='PreInvocation',timeout:event==='SessionStart'?8000:4000});
        actor={host:'agy',sessionId,callId:randomUUID(),...(registered.id?{memberId:registered.id}:{}),...(registered.binding?{binding:registered.binding}:{})};
      }
    }catch(error){
      process.stderr.write('agybridge AGY hook 登记：'+describeError(error)+'\n');
      if(!['ENOENT','ECONNREFUSED','EPIPE','disconnected','broker_timeout','timeout','starting','unverified_parent'].includes((error as {code?:string}).code??''))throw error;
    }
    if(!actor&&sessionId){
      try{
        const current=await brokerCall<{binding?:Actor['binding']}>('context.lookup',{host:'agy',configHome,pid:runtime.pid,procStart:runtime.procStart,session_id:sessionId,boundary_started_at:startedAt},{start:false,timeout:2000});
        if(current.binding)actor={host:'agy',sessionId,callId:randomUUID(),binding:current.binding};
      }catch(error){
        if(!['ENOENT','ECONNREFUSED','EPIPE','disconnected','broker_timeout','timeout','starting'].includes((error as {code?:string}).code??''))throw error;
      }
    }
    if(control){
      const resolvedActor=actor??{host:'agy',sessionId,callId:randomUUID()};
      if(control[1]==='status'){
        const text=formatStatus(await brokerCall('status',{actor:resolvedActor},{timeout:8000}))||'当前无状态信息。';
        return agyControlReply(text);
      }
      const target=control[2]&&control[2]!=='self'&&control[2]!=='agy'?'partner':'self';
      const result=await brokerCall<any>('member.switch',{actor:resolvedActor,target,enabled:control[1]==='on',user_requested:true,origin:'composer'},{mutation:true,timeout:8000});
      return agyControlReply(result.message||'已完成切换。');
    }
    const payload:Record<string,unknown>={
      ...input,
      host:'agy',
      hook_event_name:event,
      session_id:sessionId,
      context_key:contextKey,
      ...(actor?{actor}:{}),
      agybridge_timing:{identityMs,registrationMs:performance.now()-registrationStartedAt,elapsedBeforeBrokerMs:execution.elapsedMs===undefined?performance.now():execution.elapsedMs+identityMs+performance.now()-began},
    };
    const monitor=['SessionStart','PreInvocation'].includes(event);
    let result:any,notices:RuntimeNotice[]=[];
    try{
      result=await brokerCall('hook',payload,{timeout:4000,start:event==='SessionStart'||event==='PreInvocation'});
    }catch(error){
      if(!monitor)throw error;
      notices=await collectRuntimeNotices(home,'agy',sessionId,runtime,contextKey,{deadline});
      if(!notices.length)throw error;
      process.stderr.write('agybridge AGY hook：'+describeError(error)+'\n');
    }
    if(event==='PostToolUse')return{};
    if(disabledMember(home,{host:'agy',sessionId,pid:runtime.pid,procStart:runtime.procStart,configHome})){input.agybridge_disabled=true;return agyPreToolFallback();}
    if(result?.terminationBehavior==='terminate')return result;
    if(monitor&&!notices.length){
      try{notices=await collectRuntimeNotices(home,'agy',sessionId,runtime,contextKey,{deadline});}
      catch(error){process.stderr.write('agybridge 运行时监测：'+describeError(error)+'\n');}
    }
    if(notices.length&&monitor){
      provided(async()=>{for(const notice of notices)await acknowledgeRuntimeNotice(home,'agy',sessionId,runtime,notice.id,'unknown','hook output written; native admission unconfirmed',contextKey,Math.max(0,Math.min(3000,(deadline??Infinity)-performance.now())));});
      return appendAgySystemMessage(result,notices.map(runtimeNoticeText));
    }
    return result??{};
  }

  const configHome=execution.configHome??codexHome();
  const identityStartedAt=performance.now(),runtime=execution.runtime??await codexProcessIdentity(remainingTime(deadline,10000)),identityMs=execution.identityMs??performance.now()-identityStartedAt,registrationStartedAt=performance.now();
  const disabled=disabledMember(home,{host,sessionId,...runtime,configHome});
  if(disabled){
    input.agybridge_disabled=true;if(!control)return{};
    const actor={host,memberId:disabled.peerId,sessionId:disabled.sessionId!,callId:randomUUID()};
    if(control[1]==='status')return{decision:'block',reason:formatStatus(await brokerCall('status',{actor},{timeout:8000}))};
    const target=control[2]&&control[2]!=='self'&&control[2]!==host?'partner':'self';
    const result=await brokerCall<any>('member.switch',{actor,target,enabled:control[1]==='on',user_requested:true,origin:'composer'},{mutation:true,timeout:8000});
    return{decision:'block',reason:result.message};
  }
  input.context_key=`${runtime.pid}:${runtime.procStart}:${input.transcript_path??sessionId}`;
  if(event==='SubagentStop'&&typeof input.agent_id==='string'&&typeof input.agent_transcript_path==='string'&&typeof input.transcript_path==='string'){
    delete input.agent_path;
    try{input.agent_path=codexAgentPath(sessionId,input.agent_id,input.agent_transcript_path,input.transcript_path);}
    catch(error){process.stderr.write('agybridge 子代理路径读取：'+describeError(error)+'\n');}
  }
  try{
  if((!runtime.appServer||runtime.managedDaemon)&&['SessionStart','UserPromptSubmit','PostToolUse'].includes(event)&&!input.agent_id&&!input.agent_transcript_path){
    const approval=input.permission_mode?{approval:codexHookApproval(input.permission_mode)}:{};
    const registered=await brokerCall<{binding?:Actor['binding']}>('mcp.register',{host:'codex',sessionId,context_key:input.context_key,cwd:input.cwd??process.cwd(),name:'Codex',kind:'root',boundaryStartedAt:startedAt,contextStart:event==='SessionStart',contextReason:input.source==='resume'?'switch':input.source==='fork'?'fork':event==='SessionStart'&&input.source==='startup'?'reset':'unknown',permission:'unknown',endpoint:{mode:'embedded',address:'',epoch:`embedded:${runtime.pid}:${runtime.procStart}:${sessionId}`,pid:runtime.pid,procStart:runtime.procStart,configHome,codexPermission:approval,...(runtime.managedDaemon?{daemon:{address:'',...approval},processKind:'app-server'}:{})}},{start:event==='SessionStart',timeout:event==='SessionStart'?8000:2000});
    input.actor={host:'codex',sessionId,callId:randomUUID(),...(registered.binding?{binding:registered.binding}:{})};
  }
  }catch(error){
    process.stderr.write('agybridge hook 登记：'+describeError(error)+'\n');
    if(!['ENOENT','ECONNREFUSED','EPIPE','disconnected','broker_timeout','timeout','starting','daemon_thread_ended','daemon_unavailable','daemon_identity_changed','unverified_parent'].includes((error as {code?:string}).code??''))throw error;
  }
  try{
  if((!runtime.appServer||runtime.managedDaemon)&&!input.actor){
    const current=await brokerCall<{binding?:Actor['binding']}>('context.lookup',{host:'codex',configHome,pid:runtime.pid,procStart:runtime.procStart,session_id:sessionId,...(runtime.managedDaemon?{threadId:sessionId}:{}),boundary_started_at:startedAt},{start:false,timeout:2000});
    if(current.binding)input.actor={host:'codex',sessionId,callId:randomUUID(),binding:current.binding};
  }
  }catch(error){if(!['ENOENT','ECONNREFUSED','EPIPE','disconnected','broker_timeout','timeout','starting'].includes((error as {code?:string}).code??''))throw error;}
  if(control){
    const actor=input.actor??{host,sessionId,callId:randomUUID()};
    if(control[1]==='status')return{decision:'block',reason:formatStatus(await brokerCall('status',{actor},{timeout:8000}))};
    const target=control[2]&&control[2]!=='self'&&control[2]!==host?'partner':'self';
    const result=await brokerCall<any>('member.switch',{actor,target,enabled:control[1]==='on',user_requested:true,origin:'composer'},{mutation:true,timeout:8000});
    return{decision:'block',reason:result.message};
  }
  const monitor=['PostToolUse','UserPromptSubmit','SessionStart'].includes(event)&&!input.agent_id&&!input.agent_transcript_path;
  if(monitor&&event==='SessionStart'&&input.source==='compact'&&typeof input.transcript_path==='string'){
    try{input.agybridge_compacted_message_ids=await compactedMessageIds(input.transcript_path);}
    catch(error){process.stderr.write('agybridge 压缩窗口读取失败：'+describeError(error)+'\n');}
  }
  input.agybridge_timing={identityMs,registrationMs:performance.now()-registrationStartedAt,elapsedBeforeBrokerMs:execution.elapsedMs===undefined?performance.now():execution.elapsedMs+identityMs+performance.now()-began};
  let result:any,notices:RuntimeNotice[]=[];
  try{result=await brokerCall('hook',input,{timeout:2000,start:event==='SessionStart'});}
  catch(error){
    if(!monitor)throw error;
    if(event==='UserPromptSubmit'&&isEmbeddedWake(input.prompt))return{continue:false};
    notices=await collectRuntimeNotices(home,'codex',sessionId,runtime,input.context_key,{deadline});
    if(!notices.length)throw error;
    process.stderr.write('agybridge hook：'+describeError(error)+'\n');
  }
  if(disabledMember(home,{host,sessionId,...runtime,configHome})){input.agybridge_disabled=true;return{};}
  if(result?.continue===false)return result;
  if(monitor&&!notices.length)try{notices=await collectRuntimeNotices(home,'codex',sessionId,runtime,input.context_key,{deadline});}catch(error){process.stderr.write('agybridge 运行时监测：'+describeError(error)+'\n');}
  if(notices.length){
    provided(async()=>{for(const notice of notices)await acknowledgeRuntimeNotice(home,'codex',sessionId,runtime,notice.id,'unknown','hook output written; native admission unconfirmed',input.context_key,Math.max(0,Math.min(3000,(deadline??Infinity)-performance.now())));});
    const original=result?.hookSpecificOutput??{};
    return{...result,hookSpecificOutput:{...original,hookEventName:event,additionalContext:[original.additionalContext,...notices.map(runtimeNoticeText)].filter(Boolean).join('\n\n')}};
  }
  return result??{};
}

export async function hookCommand(args:string[]):Promise<void>{await runHookCommand(args,hook);}
