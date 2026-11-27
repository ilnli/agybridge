import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import {BridgeError} from './errors.js';

export const bridgeHome=()=>path.resolve(process.env.AGYBRIDGE_HOME||path.join(homedir(),'.agybridge'));
export const codexHome=()=>path.resolve(process.env.CODEX_HOME||path.join(homedir(),'.codex'));
export const agyHome=()=>path.resolve(process.env.AGY_HOME||path.join(homedir(),'.gemini'));
export const agyConfigDir=(home=agyHome())=>path.join(home,'config');
export const agyAppDataDir=(home=agyHome())=>path.join(home,'antigravity-cli');
export const AGY_APP_DATA_SUBDIRS=['antigravity-cli','antigravity','antigravity-ide'] as const;

function inside(root:string,file:string):boolean{
  const relative=path.relative(root,file);
  return !!relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);
}

function realLocation(file:string):string{
  try{return realpathSync.native(file);}
  catch(error){
    const parent=path.dirname(file);
    if((error as NodeJS.ErrnoException).code!=='ENOENT'||parent===file)throw error;
    return path.join(realLocation(parent),path.basename(file));
  }
}

export function agyAppDataDirs(home=agyHome(),env:NodeJS.ProcessEnv=process.env):string[]{
  const root=path.resolve(home),hint=env.ANTIGRAVITY_APP_DATA_DIR;
  const dirs=AGY_APP_DATA_SUBDIRS.map(name=>path.join(root,name));
  if(hint&&path.isAbsolute(hint)&&inside(root,hint)&&inside(realLocation(root),realLocation(hint)))dirs.unshift(path.resolve(hint));
  return dirs.filter((dir,index)=>!dirs.slice(0,index).some(other=>path.relative(other,dir)===''));
}

function nativeStat(file:string){
  try{return statSync(file);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}

/** A directory marker establishes the native store, but is not a readable transcript. */
export function findAgySessionEvidence(home:string,id:string,env:NodeJS.ProcessEnv=process.env):{appData:string;file:string}[]{
  if(!/^[\w-]+$/.test(id))return [];
  const matches:{appData:string;file:string}[]=[],seen=new Set<string>();
  for(const appData of agyAppDataDirs(home,env)){
    if(!nativeStat(appData))continue;
    accessSync(appData,constants.R_OK|constants.X_OK);
    const real=realpathSync.native(appData),key=process.platform==='win32'?real.toLowerCase():real;
    if(seen.has(key))continue;
    seen.add(key);
    const conversations=path.join(appData,'conversations'),brain=path.join(appData,'brain'),generated=path.join(brain,id,'.system_generated');
    for(const store of [conversations,brain])if(nativeStat(store))accessSync(store,constants.R_OK|constants.X_OK);
    const files=[path.join(conversations,id+'.db'),path.join(conversations,id+'.pb'),path.join(generated,'logs','transcript_full.jsonl'),path.join(generated,'logs','transcript.jsonl')];
    const file=files.find(candidate=>nativeStat(candidate)?.isFile())??(nativeStat(generated)?.isDirectory()?generated:undefined);
    if(file){accessSync(file,constants.R_OK);matches.push({appData,file});}
  }
  return matches;
}

export function findAgySessionAppDataDirs(home:string,id:string,env:NodeJS.ProcessEnv=process.env):string[]{
  return findAgySessionEvidence(home,id,env).map(match=>match.appData);
}

export function resolveAgyAppDataDir(home=agyHome(),conversationId?:string,env:NodeJS.ProcessEnv=process.env):string{
  const cli=agyAppDataDir(home);
  try{
    const matches=conversationId?findAgySessionAppDataDirs(home,conversationId,env):[];
    if(matches.length)return matches.includes(cli)?cli:matches[0]!;
    if(nativeStat(cli)?.isDirectory())return cli;
    const existing=agyAppDataDirs(home,env).filter(dir=>nativeStat(dir)?.isDirectory());
    if(existing.length===1)return existing[0]!;
  }catch{ /* An unverified store does not change the default location. */ }
  return cli;
}

export function ownedSocketDirectory(home:string,temporary=tmpdir(),platform:NodeJS.Platform=process.platform):string{
  const paths=platform==='win32'?path.win32:path.posix;
  let directory=paths.join(home,'run');
  const fits=(value:string)=>Buffer.byteLength(paths.join(value,'x'.repeat(24)))<100;
  if(!fits(directory)){
    const name=`agb-${createHash('sha256').update(home+userInfo().username).digest('hex').slice(0,16)}`;
    directory=paths.join(temporary,name);
    if(!fits(directory)&&platform!=='win32')directory=paths.join('/tmp',name);
    if(!fits(directory))throw new BridgeError('socket_path_too_long','没有找到满足 Unix socket 长度限制的临时目录。');
  }
  return directory;
}
export function ipcAddress(home:string):string{
  return process.platform==='win32'?`\\\\.\\pipe\\agybridge-${createHash('sha256').update(home).digest('hex').slice(0,24)}`:path.join(ownedSocketDirectory(home),'broker.sock');
}
