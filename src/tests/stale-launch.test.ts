import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { captureUserLaunch, saveUserProfile, setPreferredProfiles, type LaunchProfile } from '../hosts/launch-profiles.js';
import { launchStatus, prepareOwnedLaunch, selectHostLaunch, verifyLaunchImages } from '../hosts/host-launch.js';
import { selectSessionLaunch } from '../hosts/session-launch.js';
import { launchInputFingerprint } from '../hosts/launch-park.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import { Store } from '../storage/store.js';

function record(home:string,exe:string,patch:Partial<LaunchProfile>={}):LaunchProfile{
  return{id:exe,host:'agy',exe,version:'2.1.321 (Claude Code)',configHome:home,cwd:home,env:{PATH:'',USER_TOKEN:'原窗口凭据'},sourceSession:exe,sourcePid:1,sourceGeneration:'原代次',capturedAt:1,dropped:[],...patch};
}
function desktop(home:string,version:string,hash:string,cpu=0x0100000c){
  const file=path.join(home,'Library','Application Support','Claude','claude-code',version,hash,'claude.app','Contents','MacOS','agy');mkdirSync(path.dirname(file),{recursive:true});
  const image=Buffer.alloc(32);image.writeUInt32LE(0xfeedfacf,0);image.writeUInt32LE(cpu,4);image.writeUInt32LE(2,12);writeFileSync(file,image,{mode:0o755});return file;
}

test('失效默认记录只尝试同 home 记录，回到 PATH 时保留原 home 且不继承旧环境',t=>{
  const home=temporary(t),native=path.join(home,'native'),other=path.join(home,'other'),project=path.join(home,'other-project');for(const file of [native,other,project])mkdirSync(file);
  const valid=path.join(home,'valid'),fallback=path.join(home,process.platform==='win32'?'claude.exe':'agy');writeFileSync(valid,'隔离入口');writeFileSync(fallback,'隔离 PATH 入口');
  const missing=record(native,path.join(home,'gone'),{cwd:home,capturedAt:3}),available=record(native,valid,{cwd:home,capturedAt:1}),foreign=record(other,process.execPath,{cwd:project,capturedAt:4,version:'99.0.0 (Claude Code)'});
  for(const value of [missing,available,foreign])saveUserProfile(home,value);
  const options={home,cwd:home,baseline:{PATH:home},current:{}};
  assert.equal(selectHostLaunch('agy',DEFAULT_CONFIG,options).executable.command,valid);
  writeFileSync(path.join(home,'launch-profiles.json'),JSON.stringify({version:1,profiles:[missing,foreign],preferred:{}}));
  const before=readFileSync(path.join(home,'launch-profiles.json')),chosen=selectHostLaunch('agy',DEFAULT_CONFIG,options);
  assert.equal(chosen.method,'fallback');assert.equal(chosen.executable.command,fallback);assert.equal(chosen.configHome,native);assert.equal(chosen.env.AGY_HOME,native);assert.equal(chosen.env.USER_TOKEN,undefined);assert.match(chosen.notes.join(' '),/配置目录仍是/);
  assert.equal((launchStatus(home,DEFAULT_CONFIG,home).profiles[0] as any).availability.reason,'exe_missing');assert.deepEqual(readFileSync(path.join(home,'launch-profiles.json')),before);
  setPreferredProfiles(home,{agy:missing.sourceSession});assert.throws(()=>selectHostLaunch('agy',DEFAULT_CONFIG,options),{code:'launch_profile_missing'});
});

test('显式包装器没有可比较版本时仍交给原生能力检查，不套用自动更新入口规则',async t=>{
  const home=temporary(t),options={home,cwd:home,configHome:home,sessionId:'original',baseline:{PATH:''},current:{}};
  for(const pin of [{agyCommand:[process.execPath,'wrapper.mjs']},{agyBinary:process.execPath}]){
    const launch=await selectSessionLaunch('agy',{...DEFAULT_CONFIG,...pin},options,{version:async()=> '包装器自己的版本说明'});
    assert.equal(launch.explicitExecutable,true);assert.equal(launch.updatedFrom,undefined);
    assert.equal((await prepareOwnedLaunch(launch)).version,'包装器自己的版本说明');
  }
});

test('原启动证明的 home 消失时拒绝恢复，不通过显式程序创建空目录',t=>{
  const home=temporary(t),options={home,cwd:home,configHome:path.join(home,'missing-home'),sessionId:'original',executable:process.execPath,baseline:{PATH:''},current:{}};
  for(const config of [DEFAULT_CONFIG,{...DEFAULT_CONFIG,agyBinary:process.execPath}])assert.throws(()=>selectHostLaunch('agy',config,options),{code:'launch_profile_missing'});
  const foreign=path.join(home,'other-home');mkdirSync(foreign);
  assert.throws(()=>selectHostLaunch('agy',DEFAULT_CONFIG,{...options,configHome:home,record:record(foreign,process.execPath)}),{code:'launch_profile_missing'});
});
