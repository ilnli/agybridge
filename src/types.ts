import type { FieldObservation } from './storage/observed-fields.js';
export type Host = 'agy' | 'codex';
export interface ModelProfile {model?:string;effort?:string|number;serviceTier?:string}
export type PartnerProfileSource='recommended'|'host'|'frozen';
export type PeerState = 'ready' | 'busy' | 'needsHuman' | 'offline' | 'unknown' | 'paused' | 'starting';
export type DeliveryState = 'accepted' | 'sending' | 'runtimeQueued' | 'held' | 'contextObserved' | 'responded' | 'refused' | 'expired' | 'unknown';
export type PermissionClass = 'prompting' | 'bypass' | 'unknown';
export type ContextChangeReason = 'reset' | 'switch' | 'fork' | 'unknown';

export interface WindowIdentity {
  host: Host;
  configHome: string;
  pid: number;
  procStart: string;
  threadId?: string;
}

export interface SessionBinding extends WindowIdentity {
  key: string;
  peerId: string;
  sessionId: string;
  epoch: string;
  active: boolean;
  transitioning: boolean;
  transitionReason?: ContextChangeReason;
  observedAt: number;
  activatedAt?: number;
}

export interface ContextRotation {
  id: string;
  peerId: string;
  pairId?: string;
  oldSessionId: string;
  sessionId: string;
  oldEpoch: string;
  epoch: string;
  reason: ContextChangeReason;
  at: number;
  unanswered: string[];
  uncertain: string[];
  cancelledQuestions?: string[];
}

export interface Peer {
  id: string;
  host: Host;
  sessionId: string | null;
  cwd: string;
  name: string;
  kind: 'root' | 'subagent' | 'fork' | 'unknown';
  parentId: string | null;
  owner: 'user' | 'nxbridge';
  state: PeerState;
  pauseReason?: 'interrupted' | 'restart_incomplete';
  permission: PermissionClass;
  model?: string;
  effort?: string | number;
  serviceTier?: string | null;
  updatedAt: number;
  stateSince?: number;
  activityAt?: number;
  rootPeerId?: string;
  rootBinding?: {key:string;epoch:string};
  launchFailure?: {at:number;code?:string;message:string};
  enabled?: boolean;
}

export interface CodexPermissionEvidence {sandbox?:string;approval?:PermissionClass;autoReview?:boolean}
export interface Endpoint {
  nativeSession?:{transcriptPath?:string;transcriptPathFallback?:boolean;interactive?:boolean;artifactsDir?:string};
  codexPermissionObservation?:FieldObservation<CodexPermissionEvidence>;
  peerId: string;
  epoch: string;
  mode: 'app-server' | 'embedded' | 'agy-acp' | 'agy-tui';
  address: string;
  pid: number | null;
  procStart: string | null;
  seenAt: number;
  active: boolean;
  questionSupport?: boolean;
  configHome?: string;
  launchProfileId?: string;
  native?: {pid:number;procStart:string};
  bridge?: {pid:number;procStart:string};
  bindingEpoch?: string;
  runtimeId?: string;
  processKind?: 'foreground' | 'app-server';
  codexPermission?: CodexPermissionEvidence;
  daemon?: {address:string;rootSessionId?:string;forkedFromId?:string;sandbox?:string;approval?:PermissionClass;autoReview?:boolean};
  nativePermission?: {permission:PermissionClass;mode?:string;observedAt:number};
  nativeBackground?: {tasks?:number;crons?:number;observedAt:number};
  nativeHealth?: import('./broker/health/turn-health.js').TurnHealth;
  pendingContext?: boolean;
}

export interface Pair {
  id: string;
  agy: string;
  codex: string;
  paused: boolean;
  archived: boolean;
  createdAt: number;
}

export interface Message {
  id: string;
  pairId: string;
  from: string;
  to: string;
  body: string;
  inReplyTo: string | null;
  replySource?: 'explicit' | 'auto';
  replyExpected?: boolean;
  via: string | null;
  callId: string;
  state: DeliveryState;
  createdAt: number;
  updatedAt: number;
  evidence: string | null;
  error: string | null;
  attempts: number;
}

export interface RegisterInput {
  ownedLaunch?:{peerId:string;launchId:string};
  host: Host;
  sessionId: string;
  cwd: string;
  cwdFallback?: boolean;
  artifactsDirFallback?: boolean;
  transcriptPathFallback?: boolean;
  name?: string;
  kind?: Peer['kind'];
  parentId?: string;
  permission?: PermissionClass;
  state?: PeerState;
  boundaryStartedAt?: number;
  replyContract?: 1;
  model?: string | null;
  effort?: string | number | null;
  serviceTier?: string | null;
  endpoint: Omit<Endpoint, 'peerId' | 'seenAt' | 'active'>;
  contextStart?: boolean;
  hookContextKey?: string;
  contextReason?: ContextChangeReason;
  expectedBinding?: {key:string;epoch:string};
}

export interface Actor {
  host: Host;
  memberId?:string;
  sessionId: string;
  callId: string;
  via?: string;
  turnId?: string;
  binding?: {key: string; epoch: string};
}

export interface DeliveryResult {
  state: Exclude<DeliveryState, 'accepted' | 'sending' | 'responded'>;
  evidence: string;
}

export interface BridgeConfig {
  version: 1;
  implicit: 'on-demand' | 'never';
  compatibilityWake: 'notify' | 'strict';
  codexBinary?: string;
  agyBinary?: string;
  codexHome?: string;
  agyHome?: string;
  codexCommand?: string[];
  agyCommand?: string[];
  codexEndpoint?: string;
  codexAuthTokenEnv?: string;
  partnerProfiles?: Partial<Record<Host, ModelProfile & {source?:PartnerProfileSource}>>;
  profileWarnings?: string[];
  subagentSend: 'allow-verified' | 'deny';
  questionTimeoutMs?: number;
  syncTipMinutes: number;
  contextTipTokens: number[];
  idleNoticeMinutes: number;
  completionWakeLimit: number;
  retention?: Partial<RetentionConfig>;
}

export interface RetentionConfig {
  maintenanceIntervalMs:number;
  eventMaxAgeMs:number;
  maxEvents:number;
  historyMaxAgeMs:number;
  maxMessages:number;
  maxQuestions:number;
  maxArchivedPairs:number;
  referenceMaxAgeMs:number;
  maxReferences:number;
  maxReferenceBytes:number;
  peerMaxIdleMs:number;
  logMaxBytes:number;
  logBackups:number;
}

export const WAKE_NOTICE = 'agybridge pickup notice (not user msg): agy msg pending -> agy.receive_messages()';
export const AGY_WAKE_NOTICE = 'agybridge pickup notice (not user msg): codex msg pending -> receive_messages()';
export const HEALTH_WAKE_NOTICE = 'agybridge: runtime health notice pending; current hook provides verified facts; no partner message pickup required';
export const completionWakeId=(prompt:unknown):string|undefined=>typeof prompt==='string'&&prompt.startsWith(HEALTH_WAKE_NOTICE+'\n')?/^\[agybridge completion_notice=([^\]\s]+)\]/.exec(prompt.slice(HEALTH_WAKE_NOTICE.length+1))?.[1]:undefined;
export const isEmbeddedWake=(prompt:unknown):boolean=>prompt===WAKE_NOTICE||prompt==='agybridge: agy msg pending -> agy.receive_messages()'||prompt===HEALTH_WAKE_NOTICE||completionWakeId(prompt)!==undefined;

export function otherHost(host: Host): Host { return host === 'agy' ? 'codex' : 'agy'; }
