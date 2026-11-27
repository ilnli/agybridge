import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bridgeHome, codexHome, agyHome, ipcAddress } from '../../shared/local-paths.js';
import { ipcToken } from '../../ipc/token.js';
import { disabledMember } from '../../broker/member-state.js';
import { BridgeError } from '../../shared/errors.js';
import { type Host } from '../../types.js';

function hookEventName(input:any):string|undefined{
  return typeof input?.hook_event_name==='string'?input.hook_event_name:typeof input?.hookEventName==='string'?input.hookEventName:undefined;
}
function hookSessionId(input:any):string|undefined{
  return typeof input?.session_id==='string'?input.session_id:typeof input?.conversationId==='string'?input.conversationId:undefined;
}
function hookPrompt(input:any):string|undefined{
  return typeof input?.prompt==='string'?input.prompt:typeof input?.lastUserInput==='string'?input.lastUserInput:undefined;
}

async function request(home:string,method:string,params:unknown,timeout:number):Promise<any>{
  let token:string;try{token=ipcToken(home);}catch(error){throw Object.assign(error as Error,{hookUnsubmitted:true});}
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(ipcAddress(home));let submitted=false,done=false,buffer='';
    const finish=(error?:unknown,result?:unknown)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();if(error)reject(Object.assign(error as Error,submitted?{}:{hookUnsubmitted:true}));else resolve(result);};
    const timer=setTimeout(()=>finish(new BridgeError('timeout','hook 客户端等待协调器超时，结果尚未确认。')),Math.max(1,timeout));
    socket.setEncoding('utf8');socket.once('connect',()=>{submitted=true;socket.write(JSON.stringify({jsonrpc:'2.0',id:1,method,params,token})+'\n');});
    socket.on('error',error=>finish(error));socket.on('close',()=>finish(new BridgeError('disconnected','hook 客户端连接已断开，结果尚未确认。')));
    socket.on('data',(chunk:string)=>{
      buffer+=chunk;if(buffer.length>4*1024*1024){finish(new BridgeError('response_too_large','hook 响应超过限制。'));return;}
      const at=buffer.indexOf('\n');if(at<0)return;
      try{const reply=JSON.parse(buffer.slice(0,at));if(reply.id!==1)throw new Error('hook 响应编号无效');if(reply.error)finish(Object.assign(new BridgeError(String(reply.error.code),String(reply.error.message)),reply.error.data??{}));else finish(undefined,reply.result);}
      catch(error){finish(error);}
    });
  });
}

export async function hookClient(host:Host,input:any,provided:(ack:()=>Promise<void>)=>void,fallback:()=>Promise<unknown>):Promise<unknown>{
  const home=bridgeHome(),event=hookEventName(input),sessionId=hookSessionId(input),prompt=hookPrompt(input);
  const control=(host==='codex'&&event==='UserPromptSubmit'&&!input.agent_id&&!input.agent_transcript_path||host==='agy'&&event==='PreInvocation')&&typeof prompt==='string'&&/^\s*agybridge\s+(?:on|off|status)(?:\s+(?:self|codex|agy))?\s*$/.test(prompt);
  try{
    if(!control&&disabledMember(home,{host,sessionId})){input.agybridge_disabled=true;return host==='agy'&&event==='PreToolUse'?{decision:'allow'}:{};}
    const state=path.join(home,'setup-state.json');
    if(existsSync(state)&&JSON.parse(readFileSync(state,'utf8').replace(/^\uFEFF/,'')).disabled)return fallback();
  }catch{return fallback();}
  const inherited=Number(process.env.AGYBRIDGE_HOOK_STARTED_AT),age=performance.timeOrigin-inherited,startedAt=Number.isFinite(inherited)&&age>=0&&age<10000?inherited:performance.timeOrigin;
  const timeout=()=>Math.max(1,(host==='codex'&&['Interrupt','SessionEnd'].includes(event??'')?2300:9000)-(Date.now()-startedAt));
  let reply:any;
  const peerId=process.env.AGYBRIDGE_MANAGED_PEER,marker=process.env.AGYBRIDGE_OWNED_LAUNCH;
  const lsAddr=host==='agy'?process.env.ANTIGRAVITY_LS_ADDRESS?.trim():undefined;
  const lsCsrf=host==='agy'?process.env.ANTIGRAVITY_CSRF_TOKEN?.trim():undefined;
  try{
    reply=await request(home,host==='agy'?'hook.client.agy':'hook.client',{
      hook_pid:process.pid,
      config_home:host==='agy'?agyHome():codexHome(),
      cwd:process.cwd(),
      started_at:startedAt,
      elapsed_ms:performance.now(),
      input,
      ...(host==='agy'?{
        ...(sessionId?{conversation_id:sessionId}:{}),
        ...(peerId&&marker?.startsWith('agy:')?{owned_launch:{peerId,launchId:marker.slice(4)}}:{}),
        ...(lsAddr&&lsCsrf&&lsCsrf.length<=512?{agy_ls:{address:lsAddr,csrfToken:lsCsrf}}:{}),
      }:{}),
    },timeout());
  }
  catch(error){
    const detail=error as {hookUnsubmitted?:boolean;code?:string};
    if(detail.hookUnsubmitted||['unknown_method','-32601','starting','hook_identity_unavailable'].includes(detail.code??'')||host==='agy'&&['process_identity_unknown','agy_process_missing'].includes(detail.code??''))return fallback();
    throw error;
  }
  if(reply?.disabled)input.agybridge_disabled=true;
  if(typeof reply?.receipt==='string')provided(async()=>{await request(home,'hook.client.ack',{receipt:reply.receipt},timeout());});
  return reply?.output??{};
}
