import type { Endpoint, Peer, PermissionClass } from '../../types.js';

export interface PermissionGuidance {
  state:'class_mismatch'|'sender_unknown'|'held'|'refused';
  sender_class:PermissionClass;receiver_class:PermissionClass;receiver_host:'agy';
  receiver_member_id:string;receiver_session_id:string|null;message:string;
}

export function permissionFacts(peer:Peer,endpoint?:Endpoint){
  return{class:peer.permission,...(peer.host==='codex'?{...endpoint?.codexPermission,...(endpoint?.codexPermissionObservation?{source:endpoint.codexPermissionObservation.source,observed_at:endpoint.codexPermissionObservation.observedAt}:{})}:{})};
}

export function permissionGuidance(_codex:Peer,_agy:Peer,_endpoint?:Endpoint):PermissionGuidance|undefined{
  return undefined;
}
