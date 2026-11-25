import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {BridgeError} from './errors.js';

export const bridgeHome=()=>path.resolve(process.env.AGYBRIDGE_HOME||path.join(homedir(),'.agybridge'));
export const codexHome=()=>path.resolve(process.env.CODEX_HOME||path.join(homedir(),'.codex'));
export const agyHome=()=>path.resolve(process.env.AGY_HOME||path.join(homedir(),'.gemini'));
export const agyConfigDir=(home=agyHome())=>path.join(home,'config');
export const agyAppDataDir=(home=agyHome())=>path.join(home,'antigravity-cli');

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
