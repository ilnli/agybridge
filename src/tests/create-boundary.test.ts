import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter } from '../hosts/codex/adapter.js';
import { Store } from '../storage/store.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { temporary } from './support/temporary.js';
import type { RpcClient } from '../ipc/rpc.js';

test('Codex 运行时准备和连接失败仍可安全重试，只有原生新建前才写持久标记',async t=>{
  const home=temporary(t),store=new Store(':memory:'),peer=store.placeholder('codex',home),adapter=new CodexAdapter(DEFAULT_CONFIG,home);
  t.after(()=>{adapter.close();store.close();});
  let stage:'runtime'|'connect'|'ready'='runtime';const calls:string[]=[];
  adapter.ensureEndpoint=async(_cwd,_id,_requester,_session,_configHome,guard)=>{calls.push('runtime');await guard?.();if(stage==='runtime')throw Error('准备失败');return'ws://创建边界测试';};
  const rpc={request:async(method:string)=>{calls.push(method);if(method==='thread/start')throw Error('原生提交超时');return{};}} as RpcClient;
  adapter.connect=async()=>{calls.push('connect');if(stage==='connect')throw Error('连接失败');return rpc;};
  let marked=0;
  const create=()=>adapter.create(peer,undefined,()=>{calls.push('guard');},'bypass',()=>{marked++;calls.push('create');});
  await assert.rejects(create(),/准备失败/);assert.equal(marked,0);
  stage='connect';await assert.rejects(create(),/连接失败/);assert.equal(marked,0);
  stage='ready';await assert.rejects(create(),/原生提交超时/);assert.equal(marked,1);
  assert.deepEqual(calls.slice(-3),['guard','create','thread/start']);
});
