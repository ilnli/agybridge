import {spawn,type ChildProcess} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync,symlinkSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import path from 'node:path';
import {BridgeError} from '../shared/errors.js';
import {sameDirectory} from '../shared/files.js';
import type {Host,BridgeConfig} from '../types.js';
import {selectHostLaunch,verifyLaunchImages,type HostLaunch} from '../hosts/host-launch.js';
import {acquireHostControl,hostControlFailure} from '../hosts/host-control.js';
import {executeContainedCommand} from './contained-command.js';
import {bridgeHome} from '../shared/local-paths.js';
import {loadConfig} from '../config/load.js';
export interface Executable { command: string; prefix: string[] }

export function resolveCli(host: Host, configured?: string,pathValue=process.env.PATH??''): Executable {
  if (configured) {
    if (/\.(?:c?js|mjs)$/i.test(configured)) return { command: process.execPath, prefix: [path.resolve(configured)] };
    if (/\.(?:cmd|bat|ps1)$/i.test(configured)) throw new BridgeError('cli_shim', '请指定原生可执行文件或 npm 包的 JavaScript 入口，避免 shell 包装和参数转义。');
    return { command: configured, prefix: [] };
  }
  const extra=host==='agy'?[path.join(homedir(),'.local','bin'),path.join(homedir(),'.gemini','antigravity-cli','bin'),path.join(homedir(),'.gemini','antigravity','bin')]:[];
  const directories = [...pathValue.split(path.delimiter), path.dirname(process.execPath), ...extra];
  for (const directory of directories) {
    if (!directory) continue;
    const executable = path.join(directory, process.platform === 'win32' ? `${host}.exe` : host);
    if (existsSync(executable)) return { command: executable, prefix: [] };
    if (process.platform === 'win32' && host === 'codex') {
      const native = path.join(directory, 'node_modules', '@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
      if (existsSync(native)) return { command: native, prefix: [] };
      const js = path.join(directory, 'node_modules', '@openai/codex/bin/codex.js');
      if (existsSync(js)) return { command: process.execPath, prefix: [js] };
    }
  }
  throw new BridgeError('cli_missing', `未找到 ${host}，请安装官方 CLI 或配置 ${host}Binary。`);
}

export async function runCli(host: Host, args: string[], options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv; config?: BridgeConfig;sessionId?:string;home?:string;launch?:import('../hosts/host-launch.js').HostLaunch;beforeSpawn?:()=>void|Promise<void>;onSpawn?:()=>void } = {}): Promise<string> {
  const config = options.config ?? loadConfig();
  const source=options.launch??selectHostLaunch(host,config,{cwd:options.cwd,sessionId:options.sessionId,home:options.home});
  const selection={...source,env:options.env??source.env,cwd:options.cwd??process.cwd()};
  const verified=await verifyLaunchImages(selection,image=>runSelectedCli(host,['--version'],{...selection,executable:{command:image,prefix:[]}},{...options,timeout:8000,beforeSpawn:undefined,onSpawn:undefined}));
  if(verified!==undefined&&args.length===1&&args[0]==='--version')return verified;
  return runSelectedCli(host,args,selection,options);
}

async function runSelectedCli(host:Host,args:string[],selection:HostLaunch,options:NonNullable<Parameters<typeof runCli>[2]>):Promise<string>{
  const exe=selection.executable;
  const release=await acquireHostControl(exe.command);
  let isolatedHome:string|undefined,isolatedGemini:string|undefined;
  try{
    await options.beforeSpawn?.();
    let env=options.env??selection.env;
    if(host==='agy'&&(args[0]==='plugin'||args[0]==='plugins')){
      const currentGemini=path.join(env.USERPROFILE??env.HOME??homedir(),'.gemini');
      if(!sameDirectory(selection.configHome,currentGemini)){
        isolatedHome=realpathSync.native(mkdtempSync(path.join(tmpdir(),'agybridge-agy-home-')));
        isolatedGemini=path.join(isolatedHome,'.gemini');
        if(args[1]==='install')mkdirSync(selection.configHome,{recursive:true});
        if(existsSync(selection.configHome)){
          symlinkSync(selection.configHome,isolatedGemini,process.platform==='win32'?'junction':'dir');
        }
        env={...env,HOME:isolatedHome,...(process.platform==='win32'?{USERPROFILE:isolatedHome}:{})};
      }
    }
    const settings={cwd:options.cwd??selection.cwd,env,timeout:options.timeout??15000,maxBuffer:8*1024*1024};
    const argv=[...exe.prefix,...args];
    try{
      let stdout=(await executeContainedCommand(exe.command,argv,{...settings,home:options.home??bridgeHome(),onSpawn:options.onSpawn})).stdout;
      if(isolatedGemini){
        stdout=stdout.replaceAll(isolatedGemini,selection.configHome);
        if(process.platform==='win32'){
          stdout=stdout.replaceAll(JSON.stringify(isolatedGemini).slice(1,-1),JSON.stringify(selection.configHome).slice(1,-1));
        }
      }
      return stdout;
    }catch(error){throw hostControlFailure(host,args,error);}
  }finally{
    if(isolatedHome)try{rmSync(isolatedHome,{recursive:true,force:true});}catch{}
    release();
  }
}

export function spawnCli(host: Host, args: string[], options: Parameters<typeof spawn>[2] = {}, config = loadConfig(),home?:string): ChildProcess {
  const selection=selectHostLaunch(host,config,{cwd:typeof options?.cwd==='string'?options.cwd:undefined,home}),exe=selection.executable;
  const argv=[...exe.prefix,...args];
  return spawn(exe.command,argv,{ windowsHide: true, env:selection.env,...options, shell: false });
}
