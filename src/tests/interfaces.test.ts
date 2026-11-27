import test from 'node:test';
import { VERSION } from '../version.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { namespaceChanges } from '../install/setup.js';
import { launchMode } from '../hosts/launch.js';
import { RpcClient } from '../ipc/rpc.js';
import { AGY_PARTNER_INSTRUCTIONS, CODEX_PARTNER_INSTRUCTIONS } from '../integration/instructions.js';
import { DeliveryError } from '../shared/errors.js';
import { CLI_PATH } from '../shared/package-location.js';
import { temporary } from './support/temporary.js';
import { ensureHome } from '../ipc/home.js';
import { listenBroker } from '../ipc/ipc.js';

test('MCP 初始化按宿主提供唯一提醒，AGY 暴露 wait_partner 且不泄露中文',async t=>{
  const directory=temporary(t);
  await Promise.all((['codex','agy'] as const).map(async host=>{
    const client=new Client({name:'agybridge-instructions-test',version:VERSION});
    const home=path.join(directory,host,'bridge');await ensureHome(home);
    const broker=await listenBroker(home,async method=>{assert.equal(method,'ping');return{runtime:{buildId:'test'}};});
    const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));
    const transport=new StdioClientTransport({command:process.execPath,args:[CLI_PATH,'mcp','--host',host],env:{...env,AGYBRIDGE_HOME:home,CODEX_HOME:path.join(directory,host,'codex'),AGY_HOME:path.join(directory,host,'agy')},stderr:'pipe'});
    try{
      await client.connect(transport);
      assert.equal(client.getServerVersion()?.version,VERSION);
      const instructions=client.getInstructions()!;
      assert.equal(instructions,host==='codex'?CODEX_PARTNER_INSTRUCTIONS:AGY_PARTNER_INSTRUCTIONS);
      assert.doesNotMatch(instructions,/\p{Script=Han}/u);
      const tools=await client.listTools();assert.doesNotMatch(JSON.stringify(tools),/\p{Script=Han}/u);
      const names=tools.tools.map(tool=>tool.name);
      assert.equal(names.includes('wait_partner'),host==='agy');
      assert.ok(names.includes('send_message'));
      assert.ok(names.includes('receive_messages'));
      assert.ok(names.includes('ask'));
      assert.ok(names.includes('answer_question'));
      const skill=readFileSync(new URL(`../../plugins/${host}/skills/partner/SKILL.md`,import.meta.url),'utf8');
      assert.doesNotMatch(skill,/\p{Script=Han}|zh\.md|<!--/u);
      if(host==='codex'){
        assert.match(instructions,/^scope \(defaults; user intent overrides: msgs, AGENTS\.md\/task requirements, user wishes relayed by agy\): root rules below\. subagent: agy\.\* is refused by agybridge/);
        assert.match(instructions,/\nschedule \([^)]*\): small task -> skip upfront split talk/);
        assert.doesNotMatch(instructions,/schedule \(defaults/);
        assert.match(instructions,/pair: heavy tests\/builds \(both sides \+ subagents\) may overlap unless together they'd saturate a machine resource/);
      }
    }finally{await client.close();await broker.close();}
  }));
});

test('命名空间配置保留其他 MCP 与 Code Mode 开关',()=>{
  const changes=namespaceChanges({features:{code_mode:true,non_prefixed_mcp_tool_names:{enabled:false,server_names:['notes']}}});
  assert.deepEqual(changes[0]?.after,{enabled:true,server_names:['notes','agy']});
  assert.deepEqual(changes[1]?.after,{enabled:true,direct_only_tool_namespaces:['agy']});
  assert.equal(changes[1]?.before,true);
  assert.deepEqual(namespaceChanges({})[1]?.after,{direct_only_tool_namespaces:['agy']});
});

test('启动入口保留原生参数语义',()=>{
  for(const flag of['--no-daemon','--worktree','--add-dir','--profile','-c'])assert.equal(launchMode([flag,'value']).mode,'native');
  assert.equal(launchMode(['--model','gpt-6','任务']).mode,'native');
  assert.equal(launchMode(['resume','id']).mode,'native');
  assert.deepEqual(launchMode(['--remote','unix://custom.sock']),{mode:'remote',endpoint:'unix://custom.sock'});
  assert.equal(launchMode(['app-server','--help']).mode,'native');
});

test('RPC 区分未确认提交和普通读取；绝不代答审批',async()=>{
  const sent:any[]=[];const rpc=new RpcClient(m=>sent.push(m),()=>{});
  const mutation=rpc.request('turn/start',{}, {mutation:true});const read=rpc.request('thread/read');
  let approval:any;rpc.on('request',m=>approval=m);rpc.receive({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'x'}});
  assert.equal(approval.id,'approval');assert.equal(sent.length,2);
  rpc.disconnected();
  await assert.rejects(mutation,(e:unknown)=>e instanceof DeliveryError&&e.uncertain);
  await assert.rejects(read,(e:unknown)=>e instanceof DeliveryError&&!e.uncertain);
});
