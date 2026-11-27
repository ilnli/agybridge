import type { Endpoint, Peer, PermissionClass } from '../../types.js';

export interface PermissionGuidance {
  state:'class_mismatch'|'sender_unknown'|'held'|'refused';
  sender_class:PermissionClass;receiver_class:PermissionClass;receiver_host:'agy';
  receiver_member_id:string;receiver_session_id:string|null;message:string;
}

export function permissionFacts(peer:Peer,endpoint?:Endpoint){
  if(peer.host==='agy'){
    const native=endpoint?.nativePermission;
    return {class:peer.permission,...(native?.mode?{mode:native.mode}:{}),...(native?{observed_at:native.observedAt}:{})};
  }
  const observation=endpoint?.codexPermissionObservation;
  return {class:peer.permission,...endpoint?.codexPermission,...(observation?{source:observation.source,observed_at:observation.observedAt}:{})};
}

export function permissionGuidance(_codex:Peer,_agy:Peer,_endpoint?:Endpoint):PermissionGuidance|undefined{
  return undefined;
}
