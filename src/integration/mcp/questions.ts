import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { Store } from '../../storage/store.js';
import { memberEnabled } from '../../broker/member-control.js';
import {BridgeError} from '../../shared/errors.js';
import {QUESTION_ROUTING_INSTRUCTIONS} from '../instructions.js';
import {otherHost,type Actor,type BridgeConfig,type ContextRotation,type Host,type Pair,type Peer} from '../../types.js';

const text=z.string().min(1).max(262144);
const option=z.object({label:text,description:z.string(),preview:z.string().optional()}).strict();
const partnerQuestion=z.object({id:text,header:text,question:text,isOther:z.boolean().default(true),multiSelect:z.boolean().default(false),options:z.array(option).min(2).max(4).optional()}).strict();
export const codexAskSchema=z.object({questions:z.array(partnerQuestion).min(1).max(4)}).strict();
export const agyAskSchema=codexAskSchema;
const answerSchema=z.object({request_id:text,questions:z.array(z.unknown()).optional(),annotations:z.record(z.string(),z.unknown()).optional(),action:z.enum(['answer','needs_user']).default('answer'),answers:z.record(z.string(),z.unknown()).optional(),rationale:z.string().optional()}).strict();

const optionJson={type:'object',properties:{label:{type:'string',description:'display text; keep recommended marker eg "(Recommended)"'},description:{type:'string',description:'effect if chosen'}},required:['label','description'],additionalProperties:false};

export const codexQuestionJson={type:'object',properties:{id:{type:'string',description:'stable id'},header:{type:'string',description:'short group label'},question:{type:'string',description:'full standalone question'},isOther:{type:'boolean',description:'allow free text, default true'},multiSelect:{type:'boolean',description:'allow multiple choices, default false'},options:{type:'array',minItems:2,maxItems:4,items:optionJson,description:'give 2-4 options if user may decide'}},required:['id','header','question'],additionalProperties:false};

export const ASK_TOOL={name:'ask',description:'ask partner: returns pending+request_id at once (pending != answer); answer/timeout later as partner msg w/ same request_id; status shows state; default timeout 10min. '+QUESTION_ROUTING_INSTRUCTIONS,inputSchema:{type:'object' as const,properties:{questions:{type:'array',minItems:1,maxItems:4,items:codexQuestionJson}},required:['questions'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}};

const questionEchoJson={...codexQuestionJson,properties:{...codexQuestionJson.properties,options:{...codexQuestionJson.properties.options,items:{...optionJson,properties:{...optionJson.properties,preview:{type:'string'}}}}}};
export const ANSWER_TOOL={name:'answer_question',description:'answer pending partner q: request_id + answers for every question id + rationale. user must decide -> action=needs_user + rationale, omit answers (partner asks user natively). questions: optional exact echo. no counter-ask',inputSchema:{type:'object' as const,properties:{request_id:{type:'string'},questions:{type:'array',maxItems:4,items:questionEchoJson},action:{type:'string',enum:['answer','needs_user']},answers:{type:'object',additionalProperties:{type:'object',properties:{answers:{type:'array',items:{type:'string'}}},required:['answers'],additionalProperties:false}},rationale:{type:'string'}},required:['request_id'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}};

export interface QuestionItem {id:string;header:string;question:string;isOther:boolean;options?:{label:string;description:string;preview?:string}[];multiSelect:boolean}
export type QuestionStatus='pending'|'awaiting_user'|'answered'|'needs_user'|'timed_out'|'cancelled'|'expired';
export interface PartnerQuestion {
  id:string;pairId:string;from:string;to:string;format:Host;actorKey:string;original:unknown[];items:QuestionItem[];
  createdAt:number;expiresAt:number;status:QuestionStatus;messageId:string;turnId?:string;toolUseId?:string;
  answers?:Record<string,{answers:string[]}>;source?:{kind:'partner'|'user_via_agy';host:Host};rationale?:string;annotations?:Record<string,unknown>;
  submissions?:Record<string,{input:unknown;receipt:unknown}>;
  fallback?:'no_options';
  originEpoch?:string;
  respondentEpoch?:string;
  formLease?:string;
  terminalReason?:string;
}
const active=(q:PartnerQuestion)=>q.status==='pending'||q.status==='awaiting_user';
export function codexView(q:PartnerQuestion){return q.items.map(({id,header,question,isOther,options,multiSelect})=>({id,header,question,isOther,...(multiSelect?{multiSelect}:{}),...(options?{options}:{})}));}
export function agyView(q:PartnerQuestion){return codexView(q);}
export function questionResult(q:PartnerQuestion):Record<string,unknown>{
  const partner=otherHost(q.format);
  const needsUser=`user must decide; ask user natively in your foreground window if user owns this task, or discuss with ${partner}`;
  return{request_id:q.id,status:q.status,...(q.terminalReason?{reason:q.terminalReason}:{}),...(q.answers?{answers:q.answers,source:q.source,rationale:q.rationale,...(q.annotations?{annotations:q.annotations}:{})}:{}),...(q.status==='timed_out'?{message:`no partner answer; if needed re-ask ${partner}; native ask only if user typed task in your window`}:{}),...(q.status==='needs_user'?{rationale:q.rationale,message:needsUser}:{}),expires_at:new Date(q.expiresAt).toISOString()};
}

export class Questions {
  private waiters=new Map<string,Set<()=>void>>();
  constructor(private store:Store,private config:BridgeConfig){}
  create(pair:Pair,sender:Peer,actor:Actor,input:{questions:unknown;turn_id?:string;tool_use_id?:string}):Record<string,unknown>{
    const key=JSON.stringify([sender.id,actor.sessionId,actor.binding?.epoch??null,actor.callId]),previous=this.store.questionByCall(key);
    const original=codexAskSchema.parse({questions:input.questions}).questions;
    if(previous){if(!isDeepStrictEqual(previous.original,original))throw new BridgeError('idempotency_conflict','同一次提问不能改变问题。');return questionResult(previous);}
    this.sweep();
    if(pair.paused)throw new BridgeError('paused','配对已暂停。');
    if(this.store.questions(true).some(q=>q.pairId===pair.id))throw new BridgeError('question_pending','已有挂起问题；先用 answer_question 回答当前请求或升级给用户，不要反问。');
    const items:QuestionItem[]=original.map(q=>({id:q.id,header:q.header,question:q.question,isOther:q.isOther,options:q.options,multiSelect:q.multiSelect}));
    if(new Set(items.map(q=>q.id)).size!==items.length||new Set(items.map(q=>q.question)).size!==items.length)throw new BridgeError('ambiguous_questions','题目 id 和问题文本不能重复。');
    const now=Date.now(),q:PartnerQuestion={id:'q-'+randomUUID(),pairId:pair.id,from:sender.id,to:pair[otherHost(sender.host)],format:sender.host,actorKey:key,original,items,createdAt:now,expiresAt:now+(this.config.questionTimeoutMs??600000),status:'pending',messageId:'',turnId:input.turn_id,toolUseId:input.tool_use_id};
    q.originEpoch=this.store.bindings.current(sender.id)?.epoch;
    q.respondentEpoch=this.store.bindings.current(q.to)?.epoch;
    return this.store.transaction(()=>{
      const body=JSON.stringify({type:'agybridge.question',request_id:q.id,questions:q.items,expires_at:new Date(q.expiresAt).toISOString(),instruction:'answer_question: all answers+rationale; unsure -> action=needs_user + rationale; no counter-ask'});
      q.messageId=this.store.accept(pair,sender,body,'question:'+q.id).id;this.store.saveQuestion(q);
      return questionResult(q);
    });
  }
  get(peer:Peer,id:string):PartnerQuestion{this.sweep();const q=this.store.question(id);if(q.from!==peer.id&&q.to!==peer.id)throw new BridgeError('not_question_party','当前会话不属于这个问题。');return q;}
  view(peer:Peer,id:string):Record<string,unknown>{const q=this.get(peer,id);return{...questionResult(q),questions:q.items,from:q.from,to:q.to,format:q.format};}
  answer(peer:Peer,actor:Actor,raw:unknown,user=false,formLease?:string):unknown{
    const input=answerSchema.parse(raw);delete input.questions;
    const q=this.get(peer,input.request_id);
    if(peer.id!==q.to)throw new BridgeError('not_question_respondent','只有本次回答方可以提交答案。');
    if(user&&(!formLease||formLease!==q.formLease))throw new BridgeError('obsolete_form','原生问题表单已经失效，旧答案没有提交。');
    this.store.bindings.validate(actor);
    if(q.originEpoch&&this.store.bindings.current(q.from)?.epoch!==q.originEpoch||q.respondentEpoch&&this.store.bindings.current(q.to)?.epoch!==q.respondentEpoch)throw new BridgeError('question_expired','问题所属对话已经改变，旧表单不能提交。');
    const key=JSON.stringify([actor.sessionId,actor.binding?.epoch??null,actor.callId]),cached=q.submissions?.[key];
    if(cached){const {questions:echo,...previous}=cached.input as Record<string,unknown>;if(!isDeepStrictEqual(previous,input))throw new BridgeError('idempotency_conflict','同一次回答不能改变内容。');return cached.receipt;}
    if(!active(q))throw new BridgeError('question_expired','问题已经结束，不能提交迟到答案。');
    const pair=this.store.pairFor(peer.id);if(!pair||pair.id!==q.pairId||pair.paused)throw new BridgeError('question_expired','问题所属配对已经更换或暂停。');
    if(input.action==='needs_user'){
      if(input.answers!==undefined||!input.rationale?.trim())throw new BridgeError('invalid_upgrade','needs_user 需要说明理由，且不能同时提交答案。');
      q.rationale=input.rationale;return this.finish(q,'needs_user',key,input);
    }
    if(!input.answers||!input.rationale?.trim())throw new BridgeError('invalid_answer','作答需要完整 answers 和一次性 rationale。');
    const expected=q.items.map(item=>item.id);
    if(!isDeepStrictEqual(Object.keys(input.answers).sort(),[...expected].sort()))throw new BridgeError('incomplete_answer','答案必须完整覆盖当前问题，不能包含其他题目。');
    q.answers=Object.fromEntries(q.items.map(item=>{
      const value=input.answers![item.id];
      const answers=typeof value==='string'?[text.parse(value)]:z.object({answers:z.array(text).min(1)}).strict().parse(value).answers;
      if(!item.isOther&&answers.some(answer=>!item.options?.some(option=>option.label===answer)))throw new BridgeError('invalid_choice','该问题只接受给定选项。');
      return[item.id,{answers}];
    }));
    q.source={kind:user?'user_via_agy':'partner',host:peer.host};q.rationale=input.rationale;q.annotations=input.annotations;
    return this.finish(q,'answered',key,input);
  }
  private finish(q:PartnerQuestion,status:QuestionStatus,key?:string,input?:unknown,notifyOrigin=true):Record<string,unknown>{
    const result=this.store.transaction(()=>{
      q.status=status;const receipt=questionResult(q);
      if(key)q.submissions={...q.submissions,[key]:{input,receipt}};
      this.store.saveQuestion(q);
      const message=this.store.message(q.messageId);if(message.state==='accepted')this.store.transition(message.id,'expired','问答已结束，不再投递旧问题');
      const pair=this.store.pairFor(q.from);
      if(notifyOrigin&&pair?.id===q.pairId)this.store.accept(pair,this.store.peer(q.to),JSON.stringify({type:'agybridge.question_result',...questionResult(q)}),'question-result:'+q.id,q.messageId);
      return receipt;
    });this.changed(q.id);return result;
  }
  cancel(peer:Peer,id:string,formLease?:string):unknown{const q=this.get(peer,id);if(formLease&&q.formLease!==formLease)throw new BridgeError('obsolete_form','原生问题表单已经失效，未取消重新投递的问题。');if(!active(q))return questionResult(q);return this.finish(q,'cancelled');}
  cancelPeer(peerId:string):void{for(const q of this.store.questions(true))if(q.from===peerId||q.to===peerId)this.finish(q,'cancelled');}
  rotate(rotation:ContextRotation):void{
    for(const q of this.store.questions(true)){
      if(q.from===rotation.peerId){q.terminalReason='origin_context_changed';this.finish(q,'cancelled',undefined,undefined,false);(rotation.cancelledQuestions??=[]).push(q.id);}
      else if(q.to===rotation.peerId){
        q.status='pending';q.respondentEpoch=rotation.epoch;q.formLease=undefined;q.submissions={};
        const pair=this.store.pairFor(q.from);
        if(!pair||pair.id!==q.pairId){this.finish(q,'cancelled');continue;}
        const body=JSON.stringify({type:'agybridge.question',request_id:q.id,questions:q.items,expires_at:new Date(q.expiresAt).toISOString(),instruction:'q from partner, asked before your context changed; deadline unchanged; answer_question: all answers+rationale; unsure -> action=needs_user + rationale; no counter-ask'});
        const previous=this.store.message(q.messageId);if(previous.state==='accepted')this.store.transition(previous.id,'expired','回答方已切换上下文，问题在新上下文重新提供');
        q.messageId=this.store.accept(pair,this.store.peer(q.from),body,'question-reoffer:'+q.id+':'+rotation.epoch).id;
        this.store.saveQuestion(q);this.changed(q.id);
      }
    }
  }
  endContext(peerId:string):void{
    for(const q of this.store.questions(true)){
      if(q.from===peerId){q.terminalReason='origin_context_ended';this.finish(q,'cancelled',undefined,undefined,false);}
      else if(q.to===peerId&&q.status==='awaiting_user'){q.status='pending';q.formLease=undefined;q.submissions={};this.store.saveQuestion(q);this.changed(q.id);}
    }
  }
  private enabled(q:PartnerQuestion):boolean{return memberEnabled(this.store,this.store.peer(q.from))&&memberEnabled(this.store,this.store.peer(q.to));}
  recover():void{for(const q of this.store.questions(true))this.store.faults.sync('question_recover:'+q.id,()=>this.store.transaction(()=>{if(this.enabled(q)){q.terminalReason='broker_restarted';this.finish(q,'expired');}}));}
  sweep():void{
    for(const q of this.store.questions(true))this.store.faults.sync('question_sweep:'+q.id,()=>this.store.transaction(()=>{if(!this.enabled(q))return;const pair=this.store.pairFor(q.from);if(!pair||pair.id!==q.pairId||pair.paused)this.finish(q,'cancelled');else if(q.expiresAt<=Date.now())this.finish(q,'timed_out');}));
    for(const q of this.store.expiredQuestionRoutes())this.store.faults.sync('question_route:'+q.id,()=>this.store.transaction(()=>{if(this.enabled(q)){q.terminalReason='user_routing_timed_out';this.finish(q,'timed_out',undefined,undefined,false);}}));
  }
  async wait(peer:Peer,id:string):Promise<Record<string,unknown>>{
    const q=this.get(peer,id);if(!active(q))return this.view(peer,id);
    await new Promise<void>(resolve=>{
      const wake=()=>{clearTimeout(timer);this.waiters.get(id)?.delete(wake);if(!this.waiters.get(id)?.size)this.waiters.delete(id);resolve();};
      const timer=setTimeout(wake,Math.min(10000,Math.max(1,q.expiresAt-Date.now())));
      const listeners=this.waiters.get(id)??new Set();listeners.add(wake);this.waiters.set(id,listeners);
    });return this.view(peer,id);
  }
  private changed(id:string):void{for(const wake of [...(this.waiters.get(id)??[])])wake();}
}
