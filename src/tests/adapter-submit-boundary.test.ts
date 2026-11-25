import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter } from '../hosts/codex/adapter.js';
import { Store } from '../storage/store.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { temporary } from './support/temporary.js';

for(const disable of [false,true])test('新 Codex 后台只在真实原生变更前执行守卫，关闭状态不会穿过异步边界：'+disable,async t=>{
  const home=temporary(t),adapter=new CodexAdapter(DEFAULT_CONFIG,home),store=new Store(':memory:'),peer=store.placeholder('codex',home),calls:string[]=[];
  t.after(()=>{adapter.close();store.close();});
  adapter.ensureEndpoint=async()=>{calls.push('endpoint');return'ws://127.0.0.1:1234';};
  adapter.connect=async()=>{await Promise.resolve();if(disable)adapter.setEnabled(peer,undefined,false);return{request:async(method:string)=>{calls.push(method);if(method==='thread/start')return{thread:{id:'created',cwd:home},approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'}};return{};}} as any;};
  const create=adapter.create(peer,undefined,async()=>{calls.push('guard');},'bypass');
  if(disable){await assert.rejects(create,{code:'member_disabled'});assert.deepEqual(calls,['endpoint']);}
  else{assert.equal((await create).sessionId,'created');assert.deepEqual(calls,['endpoint','guard','thread/start','guard','thread/settings/update','thread/name/set']);}
});
