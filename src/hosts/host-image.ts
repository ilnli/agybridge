import path from 'node:path';
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import {BridgeError} from '../shared/errors.js';
import {type Host} from '../types.js';

export interface DesktopHostImages {version:string;images:string[];architecture?:string;revision:string}
export interface VerifiedHostImage {image:string;version?:string}
type ImageProbe=(image:string)=>Promise<string>;

export function desktopHostImages(_image:string,_host:Host):DesktopHostImages|undefined{
  return undefined;
}

export async function verifyHostImage(candidates:DesktopHostImages,probe:ImageProbe):Promise<VerifiedHostImage>{
  if(!candidates.images.length)throw new BridgeError('launch_profile_missing','没有可核验的宿主程序。');
  const output=await probe(candidates.images[0]!);
  return{image:candidates.images[0]!,version:output.trim()};
}

export function relaunchHostImage(image:string,host:Host,platform=process.platform):string{
  if(platform!=='win32')return updatedHostEntry(image,host)??image;
  const basename=path.win32.basename(image),prefix=host+'.exe.old.';
  return basename.toLowerCase().startsWith(prefix)&&/^\d+$/.test(basename.slice(prefix.length))?path.win32.join(path.win32.dirname(image),host+'.exe'):updatedHostEntry(image,host)??image;
}

export function updatedHostEntry(image:string,host:Host):string|undefined{
  const normalized=image.replaceAll('\\','/'),brew=/^(.*)\/(Cellar|Caskroom)\/(codex)\/([^/]+)\/(.+)$/.exec(normalized);
  let base:string,candidates:string[],allowed:(relative:string)=>boolean;
  const daemon=host==='codex'?/^(.*)\/packages\/app-server-daemon\/releases\/[^/]+\/(.+)$/.exec(normalized):undefined;
  const extension=host==='codex'?/^(.*)\/extensions\/(openai\.chatgpt)-[^/]+\/(.+)$/.exec(normalized):undefined;
  if(daemon){
    base=daemon[1]!;
    const channel='packages/app-server-daemon',suffix=daemon[2]!;
    candidates=[base+'/'+channel+'/current/'+suffix];allowed=relative=>versionedEntry(relative,channel+'/releases/',suffix);
  }else if(extension){
    base=extension[1]!;
    const root=base+'/extensions',id=extension[2]!,suffix=extension[3]!;
    candidates=[];
    try{
      const entries=JSON.parse(readFileSync(root+'/extensions.json','utf8'));
      for(const entry of Array.isArray(entries)?entries:[]){
        if(entry.identifier?.id?.toLowerCase()!==id||typeof entry.relativeLocation!=='string'||!entry.relativeLocation.startsWith(id+'-')||/[\\/]/.test(entry.relativeLocation))continue;
        const candidate=root+'/'+entry.relativeLocation+'/'+suffix;if(!candidates.includes(candidate))candidates.push(candidate);
      }
    }catch{}
    allowed=relative=>versionedEntry(relative,'extensions/'+id+'-',suffix);
    if(candidates.filter(existsSync).length!==1)return;
  }else if(brew&&host==='codex'){
    base=brew[1]!;
    const kind=brew[2]!,pkg=brew[3]!,suffix=brew[5]!;
    candidates=kind==='Cellar'?[base+'/opt/'+pkg+'/'+suffix,base+'/bin/'+host]:[base+'/bin/'+host];
    allowed=relative=>versionedEntry(relative,kind+'/'+pkg+'/',suffix);
  }else return;
  if(!path.isAbsolute(normalized))return;
  let realBase:string;
  try{realBase=realpathSync.native(base+'/');}catch{return;}
  for(const candidate of candidates)try{
    const relative=path.relative(realBase,realpathSync.native(candidate)).split(path.sep).join('/');
    if(allowed(relative))return path.normalize(candidate);
  }catch{}
}

function versionedEntry(relative:string,prefix:string,suffix:string):boolean{
  if(!relative.startsWith(prefix))return false;
  const rest=relative.slice(prefix.length),slash=rest.indexOf('/');
  return slash>0&&rest.slice(slash+1)===suffix;
}
