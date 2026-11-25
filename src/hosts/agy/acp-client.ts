import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { BridgeError, DeliveryError } from '../../shared/errors.js';
import { VERSION } from '../../version.js';

export interface AcpConfigOption {
  id:string;
  name?:string;
  category?:string;
  currentValue?:string;
  options?:{value:string;name?:string}[];
}

export interface AcpSessionResult {
  sessionId?:string;
  configOptions?:AcpConfigOption[];
  models?:{currentModelId?:string;availableModels?:{modelId:string;name?:string}[]};
  modes?:{currentModeId?:string;availableModes?:{id:string;name?:string}[]};
}

export interface AcpPermissionRequest {
  sessionId?:string;
  toolCall?:{title?:string;toolCallId?:string;kind?:string;rawInput?:unknown};
  options?:{optionId:string;name?:string;kind?:string}[];
}

interface PendingRpc {
  resolve:(value:any)=>void;
  reject:(error:unknown)=>void;
  timer?:NodeJS.Timeout;
  method:string;
}

export class AcpClient extends EventEmitter {
  private sequence=0;
  private pending=new Map<number,PendingRpc>();
  private closed=false;
  private stderrTail='';
  constructor(
    readonly child:ChildProcessWithoutNullStreams,
    private permissionHandler?:(params:AcpPermissionRequest)=>Promise<{outcome:{outcome:'selected';optionId:string}|{outcome:'cancelled'}}>,
  ){
    super();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data',(chunk:string)=>{
      this.stderrTail=(this.stderrTail+chunk).slice(-4096);
    });
    const reader=createInterface({input:child.stdout});
    reader.on('line',line=>{
      const trimmed=line.trim();
      if(!trimmed)return;
      let message:any;
      try{message=JSON.parse(trimmed);}catch{return;}
      if(!message||typeof message!=='object')return;
      if(message.id!==undefined&&(message.result!==undefined||message.error!==undefined)){
        const entry=this.pending.get(message.id);
        if(!entry)return;
        this.pending.delete(message.id);
        if(entry.timer)clearTimeout(entry.timer);
        if(message.error){
          const detail=message.error.message??JSON.stringify(message.error);
          entry.reject(new DeliveryError('acp_error',`AGY ACP ${entry.method} 失败：${detail}`,entry.method==='session/prompt'));
        }else{
          entry.resolve(message.result);
        }
        return;
      }
      if(typeof message.method==='string'){
        if(message.id!==undefined){
          void this.handleServerRequest(message.id,message.method,message.params);
        }else{
          this.emit('notification',message.method,message.params);
          if(message.method==='session/update')this.emit('update',message.params);
        }
      }
    });
    const disconnect=(error:DeliveryError)=>{
      this.failAll(error);
      this.close();
    };
    child.once('error',error=>disconnect(new DeliveryError('acp_error',`AGY ACP 进程错误：${error.message}`,true)));
    child.stdin.on('error',error=>disconnect(new DeliveryError('acp_closed',`AGY ACP 输入已关闭：${error.message}`,true)));
    reader.once('close',()=>{
      const tail=this.stderrTail.trim();
      disconnect(new DeliveryError('acp_exited',`AGY ACP 输出已关闭${tail?'：'+tail.slice(-300):'。'}`,true));
    });
    child.once('close',(code,signal)=>this.emit('exit',code,signal));
  }

  get isClosed():boolean{return this.closed||this.child.exitCode!==null||this.child.signalCode!==null;}
  get stderr():string{return this.stderrTail;}

  private failAll(error:unknown):void{
    for(const entry of this.pending.values()){
      if(entry.timer)clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private write(payload:unknown):void{
    if(this.isClosed||this.child.stdin.destroyed)throw new DeliveryError('acp_closed','AGY ACP 连接已关闭。',false);
    this.child.stdin.write(JSON.stringify(payload)+'\n');
  }

  private async handleServerRequest(id:string|number,method:string,params:any):Promise<void>{
    try{
      if(method==='session/request_permission'){
        const result=this.permissionHandler
          ?await this.permissionHandler(params as AcpPermissionRequest)
          :defaultPermissionOutcome(params as AcpPermissionRequest);
        this.write({jsonrpc:'2.0',id,result});
        return;
      }
      this.write({jsonrpc:'2.0',id,error:{code:-32601,message:`Unsupported ACP client method: ${method}`}});
    }catch(error){
      try{this.write({jsonrpc:'2.0',id,error:{code:-32000,message:error instanceof Error?error.message:String(error)}});}catch{}
    }
  }

  request<T=any>(method:string,params:unknown,timeoutMs=30000):Promise<T>{
    if(this.isClosed)return Promise.reject(new DeliveryError('acp_closed','AGY ACP 连接已关闭。',false));
    const id=++this.sequence;
    return new Promise<T>((resolve,reject)=>{
      const timer=timeoutMs>0?setTimeout(()=>{
        this.pending.delete(id);
        reject(new DeliveryError('acp_timeout',`AGY ACP ${method} 超时（${timeoutMs}ms）。`,method==='session/prompt'));
      },timeoutMs):undefined;
      this.pending.set(id,{resolve,reject,timer,method});
      try{
        this.write({jsonrpc:'2.0',id,method,params});
      }catch(error){
        this.pending.delete(id);
        if(timer)clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method:string,params:unknown):void{
    this.write({jsonrpc:'2.0',method,params});
  }

  async initialize(timeoutMs=20000):Promise<any>{
    return this.request('initialize',{
      protocolVersion:1,
      clientCapabilities:{},
      clientInfo:{name:'agybridge',version:VERSION},
    },timeoutMs);
  }

  async newSession(params:{cwd:string;mcpServers?:unknown[];_meta?:Record<string,unknown>},timeoutMs=30000):Promise<AcpSessionResult>{
    return this.request<AcpSessionResult>('session/new',{cwd:params.cwd,mcpServers:params.mcpServers??[],...(params._meta?{_meta:params._meta}:{})},timeoutMs);
  }

  async resumeSession(params:{sessionId:string;cwd:string;mcpServers?:unknown[];_meta?:Record<string,unknown>},timeoutMs=30000):Promise<AcpSessionResult>{
    return this.request<AcpSessionResult>('session/resume',{sessionId:params.sessionId,cwd:params.cwd,mcpServers:params.mcpServers??[],...(params._meta?{_meta:params._meta}:{})},timeoutMs);
  }

  async loadSession(params:{sessionId:string;cwd:string;mcpServers?:unknown[]},timeoutMs=30000):Promise<AcpSessionResult>{
    return this.request<AcpSessionResult>('session/load',{sessionId:params.sessionId,cwd:params.cwd,mcpServers:params.mcpServers??[]},timeoutMs);
  }

  async setConfigOption(sessionId:string,configId:string,value:string,timeoutMs=15000):Promise<{configOptions?:AcpConfigOption[]}>{
    return this.request('session/set_config_option',{sessionId,configId,value},timeoutMs);
  }

  prompt(sessionId:string,text:string):Promise<{stopReason?:string}>{
    return this.request('session/prompt',{sessionId,prompt:[{type:'text',text}]},0);
  }

  cancel(sessionId:string):void{
    try{this.notify('session/cancel',{sessionId});}catch{}
  }

  async closeSession(sessionId:string,timeoutMs=5000):Promise<void>{
    if(this.isClosed)return;
    try{await this.request('session/close',{sessionId},timeoutMs);}catch{}
  }

  close():void{
    if(this.closed)return;
    this.closed=true;
    this.failAll(new BridgeError('acp_closed','AGY ACP 客户端已关闭。'));
    try{this.child.stdin.end();}catch{}
    if(this.child.exitCode===null&&this.child.signalCode===null){
      try{this.child.kill('SIGTERM');}catch{}
    }
  }
}

function defaultPermissionOutcome(params:AcpPermissionRequest):{outcome:{outcome:'selected';optionId:string}|{outcome:'cancelled'}}{
  const options=params.options??[];
  const allow=options.find(opt=>opt.kind==='allow_once'||opt.kind==='allow_always'||/allow|approve/i.test(opt.optionId));
  if(allow)return{outcome:{outcome:'selected',optionId:allow.optionId}};
  return{outcome:{outcome:'cancelled'}};
}
