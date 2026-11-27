import { BridgeError } from '../../shared/errors.js';
import { modelError, referenceDeny } from '../mcp/model-error.js';

// The AGY host accepts a replacement argument object only when an argument changed.
export function agyToolReferenceDecision(name:unknown,args:Record<string,unknown>|undefined,expand:((text:string)=>string)|string){
  const field=name==='invoke_subagent'?'Prompt':name==='send_message'?'Message':name==='run_workflow'?'Args':undefined;
  if(!field||!args)return {decision:'allow'};
  const value=args[field];
  if(field==='Args'?value===null||typeof value!=='object':typeof value!=='string')return {decision:'allow'};

  let changed=false,expandedBytes=0;
  const visit=(item:unknown):unknown=>{
    if(Array.isArray(item))return item.map(visit);
    if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).map(([key,child])=>[key,visit(child)]));
    if(typeof item!=='string'||!item.includes('nxref:'))return item;
    if(typeof expand==='string')throw new Error(expand);
    const text=expand(item);
    if(text!==item){
      changed=true;
      expandedBytes+=Buffer.byteLength(text);
      if(expandedBytes>256*1024)throw new BridgeError('ref_too_large','展开正文超过 256 KiB。');
    }
    return text;
  };
  try{
    const result=visit(value);
    return changed?{decision:'allow',overwrite:{...args,[field]:result}}:{decision:'allow'};
  }catch(error){
    return {decision:'deny',reason:referenceDeny(typeof expand==='string'?expand:modelError(error).message)};
  }
}
