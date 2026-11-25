export const CODEX_DEVELOPER_ANCHOR='agybridge: partner rules in agy tool namespace description = standing developer instructions; follow all session, incl after compaction';
export const hookTimeoutMessage=(cap:number)=>`agybridge hook timed out after ${cap}s; result unconfirmed`;
export function hookGuardTimeout(entries:unknown):string|undefined{
  if(!Array.isArray(entries))return;
  return entries.find(entry=>entry?.kind==='warning'&&typeof entry.text==='string'&&/^agybridge hook timed out after (?:3|10)s; result unconfirmed$/.test(entry.text))?.text;
}

export function agyControlReply(text:string):{injectSteps:{systemMessage:{systemMessage:string}}[]}{
  return{
    injectSteps:[{
      systemMessage:{
        systemMessage:`agybridge 控制命令已由 hook 执行完成（不要调用任何工具或命令，也不要执行其他操作；请直接将下方结果原样回复给用户后立即结束本轮）：\n\n${text}`,
      },
    }],
  };
}

export function codexSessionAnchor(input:any,result:any):any{
  if(input?.agybridge_disabled===true||input?.nxbridge_disabled===true)return result;
  if(input?.hook_event_name!=='SessionStart'||input.agent_id||input.agent_transcript_path)return result;
  const original=result?.hookSpecificOutput??{};
  return{...result,hookSpecificOutput:{...original,hookEventName:'SessionStart',additionalContext:[CODEX_DEVELOPER_ANCHOR,original.additionalContext].filter(Boolean).join('\n\n')}};
}
