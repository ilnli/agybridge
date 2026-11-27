import type {Store} from '../../storage/store.js';
import {otherHost,type BridgeConfig,type Endpoint,type Peer} from '../../types.js';
import type {Adapters} from '../coordinator.js';
import type {DeletedSessions} from '../deleted-sessions.js';
import type {PartnerProfileCoordination} from '../profiles/coordination.js';
import type {BrokerHealthCoordinator} from '../health/coordinator.js';
import type {DeliveryHealth} from '../health/delivery.js';
import type {CodexDaemons} from '../../hosts/codex/codex-daemon.js';
import type {CodexDirectDelivery} from '../../hosts/codex/codex-direct.js';
import type {Takeovers} from '../recovery/takeover.js';
import {hostingRecord,writeHosting,closeHostedWindow,type SessionTransfers} from '../recovery/session-hosting.js';
import {managedRecoveryKey,recoveryPrecondition,recoveryUserStep,type ManagedRecovery,type ManagedIncident,type RecoveryNotice} from '../recovery/managed-recovery.js';
import {returnLegacyTakeover} from '../recovery/legacy-takeover.js';
import {type ManagedConflict,clearManagedConflict} from '../recovery/managed-conflicts.js';
import {reconcileManagedCodexConflict} from '../../hosts/managed-registration.js';
import {ownedProcesses} from '../../process/owned-processes.js';
import {probeProcesses,liveProcess} from '../../process/process.js';
import {runtimeFor} from '../../hosts/managed-runtimes.js';
import {partnerConfigHome} from '../pairing/pair-restore.js';
import {launchInputFingerprint,parkLaunchFailure} from '../../hosts/launch-park.js';
import {memberEnabled,requireMemberEnabled} from '../member-control.js';
import {BridgeError,RuntimeRecoveryHold,describeError} from '../../shared/errors.js';
import {sameDirectory} from '../../shared/files.js';
import {delay} from '../../shared/time.js';
import {SKIPPED} from '../fault-boundary.js';
import {TransportMigrations,ownedTransportPaths,type TransportMigration} from '../recovery/transport-migration.js';
import type {CodexContextReceipt,CodexRestartOptions} from '../../hosts/codex/adapter.js';
import {CodexRecycleControl} from '../recovery/codex-recycle-control.js';
import type {CodexRecycleAcceptance} from '../recovery/codex-recycle.js';
import type {OwnedCodexRoute} from '../../hosts/codex/codex-owned-routes.js';
import {codexSocketAlias} from '../../ipc/unix-socket.js';
import {codexDeliveryHoldText} from '../delivery/codex-delivery-hold-text.js';
import type {RetirementRecord} from '../recovery/retirement-state.js';

interface LifecycleEnvironment {readonly store:Store;readonly config:BridgeConfig;readonly adapters:Adapters;readonly home:string;}
interface LifecycleServices {
  readonly profileCoordination:PartnerProfileCoordination;
  readonly deletedSessions:DeletedSessions;
  readonly takeovers:Takeovers;
  readonly managedRecovery:ManagedRecovery;
  readonly transfers:SessionTransfers;
  readonly runtimeHealth:BrokerHealthCoordinator;
  readonly deliveryHealth:DeliveryHealth;
  readonly daemons:CodexDaemons;
  readonly codexDirect:CodexDirectDelivery;
  readonly subagentCompletions:Pick<import('../subagent-completions.js').SubagentCompletions,'pending'>;
}
interface LifecycleHooks {
  stopped():boolean;
  producersPaused():boolean;
  startupBlocked?(id:string):boolean;
  startupRecoveryBlocked?(id:string):boolean;
  migrateCodexIdentity(peer:Peer,endpoint:Endpoint,error:BridgeError):Promise<void>;
  pumpAfterCurrent():Promise<void>;
  restartCodexTransport(peer:Peer,endpoint:Endpoint,options:CodexRestartOptions):Promise<unknown>;
  foldRecycleReceipt?(peer:Peer,receipt:CodexContextReceipt):void;
}
export type StoredLaunchProof=ManagedIncident['proof']&{sessionId:string;restorePairId?:string};

export function codexRequester(store:Store,peer:Peer):string|undefined{const pair=store.pairFor(peer.id);return pair?store.peer(pair.agy).sessionId??undefined:undefined;}
export function isCodexIdentityError(error:unknown):error is BridgeError{return error instanceof BridgeError&&error.code.startsWith('codex_identity_');}

export class BrokerLifecycleCoordinator {
  private memberRecoveries=new Map<string,Promise<boolean>>();
  private restoringMembers=new Set<string>();
  private recoveryDeliveryWaits=new WeakSet<Promise<boolean>>();
  private preparing=new Map<string,Promise<void>>();
  private retiring=new Set<string>();
  private releases=new Map<string,Promise<string[]>>();
  private retryAt=new Map<string,number>();
  private recoveryFailures=new Map<string,number>();
  private recoveryAt=new Map<string,number>();
  private subscriptionHolds=new Map<string,{leaseId:string;code:'takeover_unverified'|'owned_subscription_waiting';reason:string;retryAt:number}>();
  private parkChecks=new Map<string,number>();
  private fastObserving?:Promise<void>;
  private restarting=new Set<string>();
  readonly transportMigrations:TransportMigrations;
  readonly codexRecycle:CodexRecycleControl;
  constructor(private readonly environment:LifecycleEnvironment,private readonly services:LifecycleServices,private readonly hooks:LifecycleHooks){
    this.transportMigrations=new TransportMigrations(environment.store);
    this.codexRecycle=new CodexRecycleControl({store:environment.store,home:environment.home,codex:environment.adapters.codex,
      recovery:services.managedRecovery,delivery:services.deliveryHealth,stopped:()=>hooks.stopped()||hooks.producersPaused(),
      scope:(pair,peer)=>services.runtimeHealth.noticeScope(pair,peer),incident:peer=>this.recoveryIncident(peer),
      noExternalHolder:peer=>this.assertNoLiveSessionHolder(peer),fold:(peer,receipt)=>hooks.foldRecycleReceipt?.(peer,receipt)});
  }
  private enabled(id:string):boolean{const peer=this.environment.store.getPeer(id);return !!peer&&memberEnabled(this.environment.store,peer);}
  private requireEnabled(peer:Peer):void{requireMemberEnabled(this.environment.store,peer);}
  private async pumpStage(stage:string,work:()=>unknown|Promise<unknown>):Promise<boolean>{return this.environment.store.faults.run(stage,work);}
  private background(stage:string,work:()=>unknown|Promise<unknown>):void{
    if(this.hooks.producersPaused())return;
    void this.services.runtimeHealth.trackHealth(this.pumpStage(stage,work));
  }
  get pending():boolean{return !!(this.memberRecoveries.size||this.fastObserving||this.preparing.size||this.restarting.size||this.releases.size||this.codexRecycle.pending());}
  isPreparing(id:string):boolean{return this.preparing.has(id);}
  isRestarting(id:string):boolean{return this.restarting.has(id)||this.codexRecycle.fenced(id);}
  isRetiring(id:string):boolean{return this.retiring.has(id);}
  deliveryActivationHold(id:string):'startup_route_pending'|'restart_in_progress'|'peer_retiring'|'session_conflict'|undefined{
    if(this.hooks.startupBlocked?.(id))return'startup_route_pending';
    if(this.isRestarting(id))return'restart_in_progress';
    if(this.isRetiring(id))return'peer_retiring';
    if(this.environment.store.setting('managedSessionConflict:'+id))return'session_conflict';
  }
  blocksDeliveryActivation(id:string):boolean{return !!this.deliveryActivationHold(id);}
  codexSubscriptionHold(id:string):{code:'takeover_unverified'|'owned_subscription_waiting';reason?:string}|undefined{
    const lease=this.services.takeovers.get(id);if(!lease)return;
    const hold=this.subscriptionHolds.get(id);
    return hold?.leaseId===lease.id?{code:hold.code,reason:hold.reason}:{code:'owned_subscription_waiting'};
  }
  isRestoring(id:string):boolean{return this.restoringMembers.has(id);}
  preparation(id:string):Promise<void>|undefined{return this.preparing.get(id);}
  recoveryWork(id:string):Promise<boolean>|undefined{return this.memberRecoveries.get(id);}
  async waitForRelease(id:string):Promise<void>{await this.releases.get(id);}
  async waitForReleases():Promise<void>{await Promise.allSettled(this.releases.values());}
  beginRestart(id:string):()=>void{this.codexRecycle.requireUnfenced(id);this.restarting.add(id);return()=>{this.restarting.delete(id);};}
  async requireOpenAllowed(peer:Peer):Promise<void>{
    if(peer.host==='codex')this.codexRecycle.reconcileAuthority(peer);
    this.assertOpenAllowed(peer);
  }
  assertOpenAllowed(peer:Peer):void{this.codexRecycle.requireUnfenced(peer.id);}
  retryPending(id:string):boolean{return (this.retryAt.get(id)??0)>Date.now();}
  delayRetry(id:string,delayMs:number):void{this.retryAt.set(id,Date.now()+delayMs);}
  clearRetryDelay(id:string):void{this.retryAt.delete(id);this.recoveryAt.delete(id);}
  clearBackoff(id:string):void{this.clearRetryDelay(id);this.recoveryFailures.delete(id);}
  launchInputsChanged(id?:string):void{if(id===undefined)this.parkChecks.clear();else this.parkChecks.delete(id);}

  async reconcileMembersAtStartup(runtimeEndpoint:(id:string)=>Endpoint|undefined):Promise<void>{
    const {store,adapters}=this.environment;
    for(const peer of store.peers())await this.pumpStage('startup_member:'+peer.id,()=>{
      if(!this.enabled(peer.id))adapters[peer.host].setEnabled?.(peer,runtimeEndpoint(peer.id),false);
      if(peer.host==='codex')this.codexRecycle.reconcileFinishedProfile(peer.id);
    });
  }

  async reconcileRetirementsAtStartup():Promise<void>{
    const {store,home}=this.environment;
    await this.pumpStage('startup_retirements',()=>{
      const pending=this.retirements();
      const ids=new Set(ownedProcesses(home).records.map(value=>value.peerId));
      for(const peer of store.peers())if(peer.owner==='nxbridge'&&!store.pairFor(peer.id)&&ids.has(peer.id))pending[peer.id]??={attempts:0,nextAt:0};
      this.saveRetirements(pending);
    });
  }

  ownedCodexRoute(id:string):OwnedCodexRoute|undefined{
    if(this.hooks.stopped())return;
    const {store}=this.environment,peer=store.getPeer(id);
    if(!peer?.sessionId||peer.host!=='codex'||peer.owner!=='nxbridge')return;
    const pair=store.pairFor(id);
    if(!pair||pair.paused||!this.enabled(id)
      ||this.retiring.has(id)||this.codexRecycle.fenced(id)||store.setting('managedSessionConflict:'+id)
      ||hostingRecord(store,peer)?.released||store.bindings.current(id)?.transitioning)return;
    const endpoint=store.endpoint(id);
    if(endpoint?.mode!=='app-server'||endpoint.daemon||endpoint.pendingContext||!this.services.takeovers.allowsCodexSubscription(peer,endpoint))return;
    return {peer,endpoint};
  }

  async prepare(peer:Peer,extraReason?:string,provisional?:{peerId:string;sessionId:string;authorize?:()=>void;beforeCreate?:()=>void},claimedAttempt?:string,migration?:TransportMigration):Promise<void>{
    if(this.hooks.startupBlocked?.(peer.id))throw new RuntimeRecoveryHold('startup_route_pending','原生历史正在补证，尚未启动或唤醒会话。');
    const {store,adapters}=this.environment;
    this.requireEnabled(peer);
    if(this.services.takeovers.get(peer.id))throw new BridgeError('foreground_active','前台接管仍在使用原后台，未启动另一运行时。');
    this.codexRecycle.requireUnfenced(peer.id);
    try{this.services.profileCoordination.profiles.initialize(peer);}catch(error){store.updatePeer(peer.id,{state:'offline',launchFailure:{at:Date.now(),...(error instanceof BridgeError?{code:error.code}:{}),message:describeError(error).slice(0,1200)}});throw error;}
    if(hostingRecord(store,peer)?.released)throw new BridgeError('awaiting_window','后台托管已释放，请按平时方式打开原会话；未自动恢复后台。');
    if(store.endpoint(peer.id)?.pendingContext&&peer.owner==='user')return;
    if(this.hooks.stopped()||this.retiring.has(peer.id)||!store.pairFor(peer.id)&&!provisional)throw new BridgeError('peer_releasing','搭档已离开当前配对，未启动后台进程。');
    const pending=this.preparing.get(peer.id);if(pending)return pending;
    if(this.services.deletedSessions.pendingCreation(peer.id))throw new BridgeError('session_unverified','新会话创建结果尚未核实，未重复创建；请等待原生身份登记。');
    const launch=store.setting<StoredLaunchProof>('managedLaunchProof:'+peer.id);
    if(peer.host==='codex'&&(!launch?.runtimeId||launch.sessionId!==peer.sessionId))this.rememberManagedLaunch(peer.id);
    const pairId=store.pairFor(peer.id)?.id,sessionId=peer.sessionId;
    const guard=()=>{
      const current=store.peer(peer.id),pair=store.pairFor(peer.id),sourcePair=provisional?store.pairFor(provisional.peerId):undefined;
      const selected=!!provisional&&!!pair&&pair.id===sourcePair?.id&&pair[otherHost(peer.host)]===provisional.peerId;
      if(!selected)provisional?.authorize?.();
      const intent=provisional?store.setting<{peerId:string;sessionId:string}>('implicitPartner:'+provisional.peerId):undefined;
      this.requireEnabled(current);
      this.codexRecycle.requireUnfenced(current.id);
      if(this.services.takeovers.get(peer.id))throw new BridgeError('foreground_active','前台接管仍在使用原后台，未启动另一运行时。');
      if(this.hooks.stopped()||!selected&&pair?.id!==pairId||pair?.paused||!provisional&&current.sessionId!==sessionId||provisional&&(!this.enabled(provisional.peerId)||store.peer(provisional.peerId).sessionId!==provisional.sessionId||!selected&&(intent?.peerId!==peer.id||sourcePair))||current.owner!==peer.owner||this.retiring.has(peer.id)||store.setting('managedSessionConflict:'+peer.id))throw new BridgeError('session_changed','恢复期间配对、归属或会话已经改变，未启动。');
    };
    const beforeLaunch=async()=>{
      guard();await this.assertNoLiveSessionHolder(peer);guard();
      if(!provisional&&peer.owner==='nxbridge'&&peer.sessionId){
        if(hostingRecord(store,peer)?.phase==='adopting')return;
        if(migration){this.transportMigrations.launchGuard(migration);return;}
        const incident=this.recoveryIncident(peer);
        if(claimedAttempt){
          if(incident.state!=='recovering'||incident.attempts.at(-1)?.id!==claimedAttempt)throw new BridgeError('incident_changed','消息连接恢复的启动额度已改变，未重复启动。');
        }else{this.services.managedRecovery.absent(incident);this.services.managedRecovery.claim(incident,extraReason);}
      }
    };
    const work=(async()=>{
      if(!peer.sessionId){
        const source=provisional?store.peer(provisional.peerId):pairId?store.peer(store.pairFor(peer.id)![otherHost(peer.host)]):undefined;
        let marked=false;
        const beforeCreate=provisional?.beforeCreate??(()=>{if(!marked){this.services.deletedSessions.markSelectedCreation(peer.id);marked=true;}});
        guard();
        if(peer.host==='codex')store.adopt(peer.id,await adapters.codex.create(peer,source?.sessionId??codexRequester(store,peer),guard,source?.permission??'unknown',beforeCreate));
        else store.adopt(peer.id,await adapters.agy.create(peer,guard,source?.permission??'unknown',beforeCreate));
      }else if(peer.host==='codex'){
        const attach=async(endpoint:Endpoint)=>{
          try{await adapters.codex.restoreRegisteredRoute(peer,endpoint,()=>({verify:hostingRecord(store,peer)?.phase==='adopting',prepare:guard}));}
          catch(error){
            const runtime=runtimeFor(this.environment.home,{endpoint:endpoint.address})?.value;
            if(error instanceof RuntimeRecoveryHold||!(error instanceof BridgeError)||error.code!=='policy_verification_incomplete'||peer.owner!=='nxbridge'||!runtime?.dedicated||runtime.peerId!==peer.id||runtime.sessionVerification?.sessionId!==peer.sessionId)throw error;
            guard();const pair=store.pairFor(peer.id)!,counts=store.deliveryCounts(pair.id,pair[otherHost(peer.host)]);
            if(counts.unknown+counts.sending+counts.runtimeQueued)throw new BridgeError('delivery_unsettled','权限核验被中断且仍有未结算投递，保留原运行时及消息。');
            const result=await adapters.codex.restart(peer,endpoint,guard,{verificationRecovery:true,requesterSession:codexRequester(store,peer)});guard();
            store.deactivate(peer.id,endpoint.epoch);store.event('codex.verification.restarted',{peerId:peer.id,sessionId:peer.sessionId,oldPid:result.oldPid,pid:result.pid});
          }
        };
        const previous=this.ownedCodexRoute(peer.id)?.endpoint??store.endpoints(peer.id).filter(e=>e.mode==='app-server'&&(hostingRecord(store,peer)?.phase!=='adopting'||runtimeFor(this.environment.home,{endpoint:e.address})?.value.peerId===peer.id)).sort((a,b)=>a.seenAt-b.seenAt).at(-1);
        if(previous){
          if(await adapters.codex.routeExited(peer,previous,launch)){
            guard();const active=store.endpoint(peer.id),native=active?.native??active,prior=previous.native??previous;
            if(active&&(active.epoch!==previous.epoch||active.address!==previous.address||active.bindingEpoch!==previous.bindingEpoch||active.runtimeId!==previous.runtimeId||native?.pid!==prior.pid||native?.procStart!==prior.procStart))
              throw new RuntimeRecoveryHold('owned_subscription_waiting','核验退出期间原托管端点已改变，等待重新核验。');
            store.deactivate(peer.id,previous.epoch);
          }else try{await attach(previous);return;}catch(error){if(isCodexIdentityError(error)){await this.hooks.migrateCodexIdentity(peer,previous,error);return;}if(error instanceof RuntimeRecoveryHold||peer.owner!=='nxbridge')throw error;}
        }
        if(peer.owner==='nxbridge'){
          const original=previous??store.endpoints(peer.id).sort((a,b)=>b.seenAt-a.seenAt)[0];
          guard();
          const affinity=store.setting<ManagedIncident['proof']&{sessionId:string}>('managedLaunchProof:'+peer.id),proof=affinity?.sessionId===peer.sessionId?affinity:this.services.managedRecovery.get(peer.id)?.proof;
          const address=await adapters.codex.ensureEndpoint(peer.cwd,peer.id,codexRequester(store,peer),peer.sessionId,partnerConfigHome(store,peer,proof?.configHome??original?.configHome),beforeLaunch,proof);
          guard();
          await attach({peerId:peer.id,mode:'app-server',address,epoch:address,pid:null,procStart:null,seenAt:Date.now(),active:true});guard();
          for(const old of store.endpoints(peer.id))if(old.mode==='app-server'&&old.address!==address)store.deactivate(peer.id,old.epoch);
        }
      }else if(peer.owner==='nxbridge'){
        const saved=store.setting<ManagedIncident['proof']&{sessionId:string}>('managedLaunchProof:'+peer.id),affinity={...(saved?.sessionId===peer.sessionId?saved:{}),configHome:partnerConfigHome(store,peer)};
        guard();const registration=await adapters.agy.wake(peer,store.endpoint(peer.id),guard,beforeLaunch,affinity);guard();
        store.adopt(peer.id,registration);
      }
    })().then(async()=>{const actual=store.peer(peer.id);this.services.profileCoordination.profiles.observed(actual,actual);await this.services.profileCoordination.verifyInitial(actual,true);await this.services.profileCoordination.reconcile(store.peer(peer.id));});
    this.preparing.set(peer.id,work);let handoffToTakeover=false;
    try{
      await work;if(provisional)guard();
      this.rememberManagedLaunch(peer.id);
      this.retryAt.delete(peer.id);this.recoveryAt.delete(peer.id);this.recoveryFailures.delete(peer.id);
      const incident=this.services.managedRecovery.get(peer.id);if(!migration&&incident?.state==='recovering')this.services.managedRecovery.settled(incident);
      const saved=store.setting<StoredLaunchProof>('managedLaunchProof:'+peer.id);
      if(saved?.nativeLaunchId&&saved.sessionId===peer.sessionId&&saved.restorePairId===store.pairFor(peer.id)?.id)store.setSetting('managedLaunchProof:'+peer.id,null);
      if(store.peer(peer.id).launchFailure)store.updatePeer(peer.id,{launchFailure:undefined});
    }
    catch(failure){
      if(peer.host==='codex'&&failure instanceof BridgeError&&failure.code==='foreground_active'&&this.services.takeovers.get(peer.id)?.kind==='remote')handoffToTakeover=true;
      else{
        if(failure instanceof RuntimeRecoveryHold&&store.pairFor(peer.id)){
          if(!migration)this.codexRecycle.noteHold(peer,failure);
          const incident=this.recoveryIncident(peer);
          this.services.managedRecovery.blocked(incident,failure);
          this.publishRecovery(incident,peer,describeError(failure));
          throw failure;
        }
        const error=this.services.profileCoordination.profiles.launchError(store.getPeer(peer.id)??peer,failure);
        if(peer.owner==='nxbridge'&&this.enabled(peer.id)&&!isCodexIdentityError(error)){
          store.updatePeer(peer.id,{state:'offline',launchFailure:{at:Date.now(),...(error instanceof BridgeError?{code:error.code}:{}),message:describeError(error).slice(0,1200)}});
          if(error instanceof BridgeError&&error.code==='bootstrap_policy_unsupported'&&store.pairFor(peer.id)){
            const key=(error as BridgeError&{bootstrapProbeKey?:string}).bootstrapProbeKey;
            writeHosting(store,peer,{verifying:false,reason:error.code,userStep:error.message,bootstrapProbeKey:key,nextAt:key?Number.MAX_SAFE_INTEGER:Date.now()+30000});
          }
        }
        throw error;
      }
    }
    finally{this.preparing.delete(peer.id);}
    if(handoffToTakeover)await this.repairExistingCodexSubscription(store.peer(peer.id));
  }
  async recover(peer:Peer,extraReason?:string):Promise<boolean>{
    const {store}=this.environment;
    if(this.hooks.startupBlocked?.(peer.id))return false;
    if(!this.enabled(peer.id))return false;
    if(this.codexRecycle.fenced(peer.id))return false;
    if(peer.owner==='user'&&store.setting('legacyTakeoverNeedsUser:'+peer.id))return false;
    const hosting=hostingRecord(store,peer);
    const previousIncident=this.services.managedRecovery.get(peer.id),park=hosting?.launchPark??previousIncident?.launchPark;
    if(park){
      if((this.parkChecks.get(peer.id)??0)>performance.now())return false;
      this.parkChecks.set(peer.id,performance.now()+30000);
      const proof=park.proof??store.setting<ManagedIncident['proof']>('managedLaunchProof:'+peer.id)??previousIncident?.proof??{},configHome=park.configHome??hosting?.configHome??previousIncident?.configHome??'';
      if(launchInputFingerprint(this.environment.home,this.environment.config,peer,configHome,proof)===park.fingerprint)return false;
      if(hosting?.launchPark)writeHosting(store,peer,{launchPark:undefined,bootstrapProbeKey:undefined,reason:undefined,userStep:undefined,nextAt:undefined});
      if(previousIncident?.launchPark)this.services.managedRecovery.rearm(previousIncident);
      this.recoveryAt.delete(peer.id);this.retryAt.delete(peer.id);this.parkChecks.delete(peer.id);
      store.event('recovery.inputs_changed',{peerId:peer.id,code:park.code});
    }
    if(peer.host==='codex'&&hosting?.reason==='bootstrap_policy_unsupported'&&hosting.bootstrapProbeKey){
      const proof=store.setting<ManagedIncident['proof']&{sessionId:string}>('managedLaunchProof:'+peer.id);
      try{const key=this.environment.adapters.codex.bootstrapProbeKey(peer,hosting.configHome,proof);if(key!==hosting.bootstrapProbeKey){writeHosting(store,peer,{reason:undefined,userStep:undefined,bootstrapProbeKey:undefined,nextAt:undefined});this.recoveryAt.delete(peer.id);}}catch{}
    }
    if((this.recoveryAt.get(peer.id)??0)>Date.now()||(hostingRecord(store,peer)?.nextAt??0)>Date.now())return false;
    let incident:ManagedIncident|undefined;
    if(peer.owner==='nxbridge'&&peer.sessionId){
      const previous=this.services.managedRecovery.get(peer.id);if(previous?.state!=='closed')incident=previous;
      const watching=incident?.recycle?.trigger==='loaded_unleased'&&!this.codexRecycle.fenced(peer.id);
      if(incident&&!watching&&!extraReason&&!this.services.managedRecovery.due(incident))return false;
    }
    try{
      if(peer.host==='codex'&&hostingRecord(store,peer)?.phase==='adopting'){await this.services.transfers.adopt(peer);return true;}
      if(peer.owner==='nxbridge'){
        const active=store.endpoint(peer.id);
        const issue=active?(await this.services.runtimeHealth.probeRuntime(peer)).deliveryIssue:undefined;
        if(peer.host==='codex'&&active&&issue==='codex_socket_target_missing'){
          await this.restartCodexTransport(peer,active,undefined,extraReason);
          const restored=store.endpoint(peer.id);return !!restored&&restored.epoch!==active.epoch;
        }
        await this.prepare(peer,extraReason);
        if(store.peer(peer.id).state==='offline'||!store.endpoint(peer.id))throw new BridgeError('recovery_pending','原会话尚未恢复就绪。');
        if(peer.host==='codex'&&this.services.takeovers.get(peer.id)&&!this.environment.adapters.codex.hasSubscription(store.peer(peer.id),store.endpoint(peer.id)!))return false;
      }else{
        const endpoint=store.endpoints(peer.id).filter(e=>e.mode==='app-server').sort((a,b)=>a.seenAt-b.seenAt).at(-1);
        if(!endpoint)return false;
        await this.environment.adapters.codex.connect(endpoint.address);
        const current=store.endpoints(peer.id).filter(e=>e.mode==='app-server').sort((a,b)=>a.seenAt-b.seenAt).at(-1);
        if(current?.epoch!==endpoint.epoch||current.bindingEpoch!==endpoint.bindingEpoch||store.peer(peer.id).sessionId!==peer.sessionId)return false;
        store.saveEndpoint({...current,active:true,seenAt:Date.now()});
      }
      incident??=this.services.managedRecovery.get(peer.id);this.recoveryAt.delete(peer.id);this.recoveryFailures.delete(peer.id);
      if(incident&&incident.state!=='closed'){this.services.managedRecovery.settled(incident);this.publishRecovery(incident,peer,'restored same session; no task replayed');}
      return true;
    }catch(error){
      if(error instanceof RuntimeRecoveryHold||isCodexIdentityError(error))return false;
      if(peer.owner==='nxbridge'&&peer.sessionId)incident=this.recoveryIncident(peer);
      if(incident){
        if(recoveryPrecondition(error))this.services.managedRecovery.blocked(incident,error,parkLaunchFailure(error,this.environment.home,this.environment.config,peer,incident.configHome,incident.proof));
        else if(!['recovery_backoff','recovery_exhausted','recovery_rate_limited','recovery_not_exhausted'].includes((error as BridgeError).code)){
          const migration=this.transportMigrations.get(peer.id),interrupted=migration?.sessionId===peer.sessionId&&migration.attempts>0&&['unknown','restarting'].includes(migration.state);
          this.services.managedRecovery.settled(incident,error,(!!incident.attempts.length||interrupted)&&['runtime_launch_unconfirmed','recovery_uncertain','process_identity_unknown','timeout'].includes((error as BridgeError).code));
        }
        this.publishRecovery(this.services.managedRecovery.get(peer.id)!,peer,'recovery held: '+describeError(error));return false;
      }
      const failures=(this.recoveryFailures.get(peer.id)??0)+1,wait=Math.min(60000,1000*2**Math.min(failures-1,6));
      this.recoveryFailures.set(peer.id,failures);this.recoveryAt.set(peer.id,Date.now()+wait);
      store.event('recovery.failed',{peerId:peer.id,retryInMs:wait,error:describeError(error)});return false;
    }
  }
  private recoveryIncident(peer:Peer):ManagedIncident{
    const {store}=this.environment;
    const pair=store.pairFor(peer.id);if(!pair)throw new BridgeError('unpaired','成员已离开配对，未恢复。');
    const endpoint=store.endpoints(peer.id).sort((a,b)=>b.seenAt-a.seenAt)[0],runtime=peer.host==='codex'?runtimeFor(this.environment.home,{peerId:peer.id})?.value:undefined;
    const saved=store.setting<ManagedIncident['proof']&{sessionId:string}>('managedLaunchProof:'+peer.id),proof=runtime?{runtimeId:runtime.id,configHome:runtime.configHome,executable:runtime.executable,version:runtime.version,profileId:runtime.profileId}:saved?.sessionId===peer.sessionId?saved:{};
    const incident=this.services.managedRecovery.observe(peer,pair,endpoint,proof);
    if(!incident.notice){const health=this.services.runtimeHealth.peerHealth(peer),children=store.peers().filter(child=>child.kind==='subagent'&&['busy','starting','needsHuman','unknown'].includes(child.state)&&(child.rootPeerId===peer.id||child.parentId===peer.sessionId)).map(child=>child.sessionId!).filter(Boolean).slice(0,32);incident.notice={incident_id:incident.id,partner:peer.name,happened:'native endpoint unavailable at '+new Date(incident.openedAt).toISOString(),nxbridge_did:'read-only reconciliation',msgs:{held:0,uncertain:0},wake:false,...(health&&!['ready','failed'].includes(health.state)||children.length?{interrupted:{turn_id:health?.turnId,tools:health?.tools.slice(0,16)??[],children,effects:'prior tool effects require history inspection; nothing replayed'}}:{})};store.setSetting(managedRecoveryKey(peer.id),incident);}
    return incident;
  }
  private publishRecovery(incident:ManagedIncident,peer:Peer,did:string):void{
    if(incident.recycle&&(incident.recycle.phase!=='handback'||incident.state==='ready'))return;
    const {store}=this.environment;
    const pair=store.pairFor(peer.id);if(!pair||pair.id!==incident.pairId)return;
    const recipient=store.peer(pair[otherHost(peer.host)]),bootstrapToAgy=incident.state==='blocked'&&incident.preconditionCode==='bootstrap_required'&&recipient.host==='agy';
    const counts=store.deliveryCounts(pair.id,pair[otherHost(peer.host)]),extra=incident.state==='exhausted'&&incident.attempts.filter(row=>!row.extra&&!row.user).length===3&&!incident.attempts.some(row=>row.extra),unfinished=incident.state==='ready'&&incident.attempts.length>0&&!!incident.notice?.interrupted;
    const prior={...incident.notice!};delete prior.ai_action;delete prior.user_step;
    const step=recoveryUserStep(peer,incident),payload:RecoveryNotice={...prior,incident_id:incident.id,partner:peer.name,nxbridge_did:did,msgs:{held:counts.held+counts.accepted,uncertain:counts.unknown+counts.sending+counts.runtimeQueued},wake:!incident.wakeAdmitted&&(extra||unfinished),...(bootstrapToAgy?{ai_action:'attempt agybridge bootstrap once; it verifies independent launch before handover. If refused, tell the user in the originating window to run agybridge bootstrap in ordinary PowerShell outside AGY/Codex. Keep pending messages; do not resend.'}:extra?{ai_action:'inspect recovery; request recover_partner retry once with recorded reason'}:unfinished?{ai_action:'inspect original history, partial work and unresolved effects; decide whether a NEW authorized check-progress instruction is needed'}:{}),...(step?{user_step:step}:{})};
    incident.notice=payload;store.setSetting(managedRecoveryKey(peer.id),incident);
    const message='agybridge runtime notice (not partner task or user approval): '+JSON.stringify(payload)+'; to stop managed recovery, human may use agybridge off '+peer.host+' or unpair.';
    if(!incident.noticeAdmitted||payload.wake)this.services.deliveryHealth.enqueue(pair.id,recipient.id,{id:incident.noticeId+(incident.noticeAdmitted?':action':''),message,state:'pending',source:'managed_recovery',kind:'managed_recovery:'+peer.id,scope:this.services.runtimeHealth.noticeScope(pair,recipient),incidentId:incident.id,recovery:payload,wake:payload.wake,tier:bootstrapToAgy?3:undefined});
  }
  observeManagedExits():Promise<void>{
    const {store}=this.environment;
    if(this.fastObserving)return this.fastObserving;
    const work=(async()=>{
      for(const pair of store.pairs())for(const id of [pair.agy,pair.codex]){
        if(this.hooks.stopped())return;
        await this.pumpStage('managed_exit:'+id,async()=>{
          const peer=store.peer(id);if(!this.enabled(id)||!peer.sessionId||!['root','fork'].includes(peer.kind))return;
          if(peer.owner==='user')await returnLegacyTakeover(store,this.environment.home,peer);
          const legacy=store.setting<{sessionId:string;user_step:string}>('legacyTakeoverNeedsUser:'+id);
          if(legacy?.sessionId===peer.sessionId){const recipient=store.peer(pair[otherHost(peer.host)]);this.services.deliveryHealth.enqueue(pair.id,recipient.id,{id:'legacy-takeover:'+id,source:'pair_anomaly',kind:'legacy_takeover:'+id,state:'pending',scope:this.services.runtimeHealth.noticeScope(pair,recipient),factKey:JSON.stringify([id,peer.sessionId]),message:`agybridge runtime notice (not partner task or user approval): earlier takeover ownership cannot be verified; no automatic launch or stop. User: open original ${peer.host} config home in ${peer.cwd} and run ${legacy.user_step}; same-session continuity is preserved when verified.`});}
          const takeover=this.services.takeovers.get(id);if(takeover)await this.returnTakeover(id,takeover.id);
          const endpoints=store.endpoints(id),endpoint=endpoints.filter(ep=>ep.active&&!ep.daemon).sort((a,b)=>b.seenAt-a.seenAt)[0];
          if(endpoint?.pid&&!liveProcess(endpoint.pid)){if(peer.host==='codex'&&peer.owner==='user')closeHostedWindow(store,peer,endpoint.epoch);else{store.deactivate(id,endpoint.epoch);if(peer.state!=='paused')store.updatePeer(id,{state:'offline'});}}
          const conflict=store.setting<ManagedConflict>('managedRuntimeConflict:'+id);
          if(conflict&&peer.host==='codex'){
            await reconcileManagedCodexConflict(store,this.environment.home,store.peer(id),(runtime,session)=>this.environment.adapters.codex.inspectThread(runtime,session));
            if(store.setting('managedRuntimeConflict:'+id)&&endpoint?.mode==='app-server'&&await this.environment.adapters.codex.sessionState({...peer,sessionId:conflict.sessionId},endpoint)==='dead')clearManagedConflict(store,id,conflict.runtimeId,conflict.sessionId,conflict);
          }
          if(this.hooks.startupBlocked?.(id))return;
          await this.services.transfers.reconcileOwned(store.peer(id));
          const hosting=hostingRecord(store,store.peer(id));
          if(peer.host==='codex'&&hosting?.phase==='releasing'&&(hosting.nextAt??0)<=Date.now()&&!this.services.takeovers.get(id)){this.background('hosting_release:'+id,()=>this.services.transfers.release(store.peer(id)));return;}
          if(peer.host==='codex'&&hosting?.background&&!hosting.released&&(hosting.nextAt??0)<=Date.now()&&peer.owner==='user'&&!pair.paused&&!this.services.takeovers.get(id)&&(this.recoveryAt.get(id)??0)<=Date.now()){
            const state=await this.nativeSessionState(store.peer(id));if(state==='dead'){closeHostedWindow(store,store.peer(id));this.background('hosting_adopt:'+id,()=>this.services.transfers.adopt(store.peer(id)));return;}
          }
        });
      }
    })().finally(()=>{if(this.fastObserving===work)this.fastObserving=undefined;});this.fastObserving=work;return work;
  }
  recoveryStatus(peer:Peer){
    const {store}=this.environment;
    if(store.setting('managedSessionConflict:'+peer.id))return{incident_id:'conflict:'+peer.id,state:'blocked',attempts_used:0,attempts_max:3,precondition:'session_conflict',user_step:'agybridge pair',held:0,uncertain:0};
    const legacy=store.setting<{sessionId:string;user_step:string}>('legacyTakeoverNeedsUser:'+peer.id);if(legacy?.sessionId===peer.sessionId)return{incident_id:'legacy:'+peer.id,state:'blocked',attempts_used:0,attempts_max:3,precondition:'legacy_takeover_unverified',user_step:legacy.user_step,held:0,uncertain:0};
    const adopted=store.setting<{at:number;sessionId:string}>('managedAdopted:'+peer.id);if(adopted?.sessionId===peer.sessionId&&Date.now()-adopted.at<60000)return{incident_id:'adopted:'+peer.id,state:'ready',attempts_used:0,attempts_max:3,held:0,uncertain:0,adopted:true};
    const value=this.services.managedRecovery.get(peer.id);if(!value||value.sessionId!==peer.sessionId||value.state==='closed')return undefined;
    const pair=store.pairFor(peer.id),counts=pair?store.deliveryCounts(value.pairId,pair[otherHost(peer.host)]):undefined;
    return{incident_id:value.id,state:value.state==='pending'?'recovering':value.state,attempts_used:value.attempts.filter(row=>!row.extra&&!row.user).length,attempts_max:3,extra_used:value.attempts.some(row=>row.extra),next_at:value.nextAt||undefined,precondition:value.preconditionCode,user_step:value.recycle?.phase==='held'||value.recycle?.phase==='handback'?recoveryUserStep(peer,value):value.notice?.user_step,held:(counts?.held??0)+(counts?.accepted??0),uncertain:(counts?.unknown??0)+(counts?.sending??0)+(counts?.runtimeQueued??0),
      ...(value.recycle?{recycle:this.codexRecycle.summary(peer,value)}:{})};
  }
  async acceptCodexRecycle(peer:Peer,acceptance:CodexRecycleAcceptance):Promise<string|undefined>{
    if(this.hooks.startupBlocked?.(peer.id))throw new RuntimeRecoveryHold('startup_route_pending','会话正在核对交接记录，暂不回收。');
    if(this.preparing.has(peer.id)||this.restarting.has(peer.id)||this.retiring.has(peer.id))throw new BridgeError('restart_in_progress','原会话还有一次生命周期操作，暂不回收。');
    const previous=this.services.managedRecovery.get(peer.id);
    await this.codexRecycle.advance(peer,acceptance);
    return this.codexRecycle.acceptanceText(peer,previous,acceptance);
  }
  async nativeSessionState(peer:Peer):Promise<'alive'|'dead'|'unknown'>{
    const all=this.environment.store.endpoints(peer.id).sort((a,b)=>b.seenAt-a.seenAt),active=all.filter(ep=>ep.active),endpoints=active.length?active:all.slice(0,1);if(!endpoints.length)return'dead';
    const states=await Promise.all(endpoints.map(async endpoint=>{
      const native=endpoint.native??endpoint;if(!native.pid||!native.procStart)return'unknown' as const;
      const state=(await probeProcesses([{pid:native.pid,procStart:native.procStart}]))[0]??'unknown';
      if(state!=='alive'||peer.host!=='codex')return state;
      if(endpoint.daemon){
        try{const connection=endpoint.configHome?await this.services.daemons.scan(endpoint.configHome,{pid:native.pid,procStart:native.procStart},true):undefined;return connection?connection.threads.some(thread=>thread.id===peer.sessionId)?'alive' as const:'dead' as const:'unknown' as const;}
        catch(error){if(error instanceof BridgeError&&error.code==='daemon_snapshot_changed')return'unknown' as const;throw error;}
      }
      if(endpoint.mode!=='app-server')return state;
      return this.environment.adapters.codex.sessionState?this.environment.adapters.codex.sessionState(peer,endpoint):'unknown' as const;
    }));return states.includes('alive')?'alive':states.every(state=>state==='dead')?'dead':'unknown';
  }
  async assertNoLiveSessionHolder(peer:Peer):Promise<void>{
    const {store}=this.environment;
    if(!peer.sessionId)return;const home=partnerConfigHome(store,peer),homes=[...store.endpoints(peer.id).flatMap(ep=>ep.configHome?[ep.configHome]:[]),...(home?[home]:[])];
    const holders=()=>store.peersForSession(peer.host,peer.sessionId!).filter(other=>other.id!==peer.id&&['root','fork'].includes(other.kind)).flatMap(other=>store.endpoints(other.id).filter(ep=>ep.active&&ep.configHome&&homes.some(home=>sameDirectory(home,ep.configHome!))).map(endpoint=>({peer:other,endpoint})));
    const others=holders(),snapshot=JSON.stringify(others);
    for(const {peer:other} of others)if(await this.nativeSessionState(other)!=='dead')throw new BridgeError('foreground_active','同一配置目录和会话仍由另一成员使用，或其状态待核验，未重复恢复。');
    if(JSON.stringify(holders())!==snapshot)throw new BridgeError('session_changed','核验期间原会话的持有窗口已经改变，请重新选择。');
  }
  async returnTakeover(peerId:string,leaseId:string,foregroundEnded=false):Promise<boolean>{
    if(this.hooks.startupBlocked?.(peerId))return false;
    const {store}=this.environment;
    const lease=this.services.takeovers.get(peerId);if(!lease)return true;
    if(lease.adopted&&!lease.adopted.retirementChecked&&store.peer(peerId).host==='codex'&&lease.adopted.endpoint){
      lease.adopted.retirementChecked=true;store.setSetting('takeover:'+peerId,lease);
      const references=store.endpoints().filter(ep=>{const peer=store.peer(ep.peerId);return ep.active&&!(ep.mode==='app-server'&&peer.host==='codex'&&peer.kind==='subagent');}),note=await this.environment.adapters.codex.releaseRuntime(references,lease.adopted.endpoint.address,[{...store.peer(peerId),owner:'nxbridge'}]);
      if(note)store.event('takeover.old_runtime_retained',{peerId,note});
    }
    if(!await this.services.takeovers.returned(peerId,leaseId,foregroundEnded))return false;
    const peer=store.peer(peerId);if(peer.sessionId!==lease.sessionId||store.pairFor(peerId)?.id!==lease.pairId)return true;
    this.services.profileCoordination.profiles.clear(peer);
    if(peer.host==='codex'&&hostingRecord(store,peer)?.released){
      closeHostedWindow(store,peer);writeHosting(store,peer,{phase:'releasing'});
      try{await this.services.transfers.release(store.peer(peerId));}catch(error){store.event('hosting.release_pending',{peerId,reason:describeError(error)});}return true;
    }
    if(lease.adopted){store.deactivate(peerId);const binding=store.bindings.current(peerId);if(binding)store.bindings.save({...binding,active:false});if(lease.adopted.endpoint)store.saveEndpoint({...lease.adopted.endpoint,active:false,seenAt:Date.now()});store.updatePeer(peerId,{owner:'nxbridge',state:'offline'});store.setSetting('managedAdopted:'+peerId,null);store.event('takeover.custody_returned',{peerId,sessionId:peer.sessionId});return true;}
    if(lease.kind==='child'||lease.endpoint?.pid&&!liveProcess(lease.endpoint.pid)){store.deactivate(peerId);if(peer.owner==='nxbridge'&&peer.state!=='paused')store.updatePeer(peerId,{state:'offline'});}
    return true;
  }
  private async repairExistingCodexSubscription(peer:Peer):Promise<void|typeof SKIPPED>{
    const {store,adapters}=this.environment,pair=store.pairFor(peer.id);
    if(peer.host!=='codex'||peer.owner!=='nxbridge'||!peer.sessionId||!pair||this.preparing.has(peer.id)||this.codexRecycle.fenced(peer.id))return;
    const endpoint=store.endpoint(peer.id)??store.endpoints(peer.id).filter(ep=>ep.mode==='app-server'&&!ep.daemon&&!ep.pendingContext).sort((a,b)=>b.seenAt-a.seenAt)[0];
    if(!endpoint||endpoint.mode!=='app-server'||endpoint.daemon||endpoint.pendingContext)return;
    if(adapters.codex.hasSubscription(peer,endpoint)){this.subscriptionHolds.delete(peer.id);return;}
    const lease=this.services.takeovers.get(peer.id),previous=this.subscriptionHolds.get(peer.id);
    if(lease&&previous?.leaseId===lease.id&&previous.retryAt>Date.now())return SKIPPED;
    const guard=()=>{
      const current=store.peer(peer.id),paired=store.pairFor(peer.id);
      if(!this.services.takeovers.allowsCodexSubscription(current,endpoint))throw new RuntimeRecoveryHold('takeover_unverified',codexDeliveryHoldText('takeover_unverified').status);
      if(this.hooks.producersPaused()||current.owner!=='nxbridge'||current.sessionId!==peer.sessionId||paired?.id!==pair.id||paired.paused
        ||!this.enabled(peer.id)||!this.enabled(pair.agy)||this.retiring.has(peer.id)||this.restarting.has(peer.id)
        ||store.setting('managedSessionConflict:'+peer.id)||store.bindings.current(peer.id)?.transitioning||hostingRecord(store,current)?.released||this.codexRecycle.fenced(peer.id))
        throw new RuntimeRecoveryHold('owned_subscription_waiting','核对原订阅期间会话或归属已改变，等待重新核验。');
    };
    this.restoringMembers.add(peer.id);
    try{
      guard();
      await adapters.codex.attach(peer,endpoint,{prepare:guard,...(this.services.takeovers.get(peer.id)?{subscribeLoaded:()=>this.services.takeovers.codexSubscriptionGuard(peer,endpoint)}:{})});guard();
      this.subscriptionHolds.delete(peer.id);
    }catch(error){
      const current=this.services.takeovers.get(peer.id);
      if(current&&error instanceof BridgeError){
        const code=error.code==='takeover_unverified'?'takeover_unverified':'owned_subscription_waiting';
        const reason=describeError(error).slice(0,1200);
        this.subscriptionHolds.set(peer.id,{leaseId:current.id,code,reason,retryAt:Date.now()+5000});
        if(previous?.leaseId!==current.id||previous.code!==code)store.event('codex.subscription.held',{peerId:peer.id,leaseId:current.id,code,reason});
        return SKIPPED;
      }
      this.codexRecycle.noteHold(peer,error);throw error;
    }
    finally{this.restoringMembers.delete(peer.id);}
  }
  private async recoverPairedPeer(id:string,hasPending:boolean):Promise<void|typeof SKIPPED>{
    const {store}=this.environment;
    const peer=store.getPeer(id),pair=store.pairFor(id);
    if(this.hooks.stopped()||!peer)return;
    if(!pair||pair.paused||!this.enabled(id)||this.retiring.has(id)||this.restarting.has(id)
      ||store.setting('managedSessionConflict:'+id)||hostingRecord(store,peer)?.released||['paused','needsHuman'].includes(peer.state)){
      if(peer.host==='codex')this.codexRecycle.reconcileAuthority(peer);
      return;
    }
    if(this.services.takeovers.get(id)){
      if(peer.host==='codex'){this.codexRecycle.reconcileAuthority(peer);return this.repairExistingCodexSubscription(peer);}
      return;
    }
    if(this.hooks.startupBlocked?.(id))return this.repairExistingCodexSubscription(peer);
    if(peer.state==='ready')this.services.deliveryHealth.promoteIdleNotices(pair.id,id);
    if(peer.host==='codex'){
      if(peer.owner==='nxbridge'&&!this.preparing.has(id)){
        if(await this.codexRecycle.advance(peer))return;
      }else this.codexRecycle.reconcileAuthority(peer);
    }
    if(peer.owner==='nxbridge')this.transportMigrations.reconcile(id);
    for(const endpoint of store.endpoints(id))if(endpoint.active&&!endpoint.daemon&&endpoint.pid&&!liveProcess(endpoint.pid))store.deactivate(id,endpoint.epoch);
    const endpoint=store.endpoint(id);
    if(endpoint?.pendingContext)return;
    let restore:(()=>Promise<unknown>)|undefined;
    if(peer.owner==='nxbridge'){
      const availability=endpoint?await this.services.runtimeHealth.probeRuntime(peer):undefined;
      if(availability?.deliveryIssue==='codex_socket_target_missing'){
        this.services.managedRecovery.ready(id,false);
        await this.restartCodexTransport(peer,endpoint!);return;
      }
      if(endpoint&&peer.sessionId&&peer.host==='codex'){
        const migration=this.observeTransport(peer,endpoint);
        if(migration&&this.transportMigrations.due(migration)){
          await this.restartCodexTransport(peer,endpoint,migration);
          return;
        }
      }
      const ownedRoute=this.ownedCodexRoute(id);
      const reconciliation=ownedRoute&&this.environment.adapters.codex.reconcileOwnedRoute?.(ownedRoute,()=>this.recover(ownedRoute.peer));
      if(reconciliation){
        this.restoringMembers.add(id);
        try{await reconciliation;}finally{this.restoringMembers.delete(id);}
        return;
      }
      this.services.managedRecovery.ready(id,!!endpoint&&peer.state!=='offline'&&(!availability||availability.state==='reachable'));
      if(!peer.sessionId){if(hasPending&&!peer.launchFailure)restore=()=>this.prepare(peer);}
      else if(!endpoint||peer.state==='offline')restore=()=>this.recover(peer);
    }else if(peer.host==='codex'&&peer.sessionId&&!endpoint)restore=()=>this.recover(peer);
    if(restore){this.restoringMembers.add(id);try{await restore();}finally{this.restoringMembers.delete(id);}}
  }

  private observeTransport(peer:Peer,endpoint:Endpoint):TransportMigration|undefined{
    const {home,store}=this.environment;
    const runtime=peer.host==='codex'?runtimeFor(home,{endpoint:endpoint.address})?.value:undefined;
    const owners=ownedProcesses(home).records,paths=ownedTransportPaths(home,peer,endpoint,owners,runtime);
    return this.transportMigrations.observe(peer,store.pairFor(peer.id)?.id??'',endpoint,paths);
  }
  transportStatus(peer:Peer):unknown{
    const value=this.transportMigrations.get(peer.id),migration=value?.sessionId===peer.sessionId?value:undefined;
    const endpoint=this.environment.store.endpoint(peer.id);
    let limitation:unknown;
    if(process.platform==='darwin'&&peer.host==='codex'&&endpoint?.address.startsWith('unix://')){
      try{limitation={code:'native_fixed_directory',path:codexSocketAlias(endpoint.address.slice(7)),reason:'Codex 原生保护 socket 固定在系统临时目录；当前接口不能迁到持久目录。路径丢失后只在核验安全空闲和原连接后恢复同一会话。'};}catch{}
    }
    return migration||limitation?{...(migration?{id:migration.id,state:migration.state,source:migration.source,paths:migration.paths,attempts:migration.attempts,max_attempts:1,code:migration.code,reason:migration.reason,next_at:migration.nextAt,replacement:migration.replacement}:{}),...(limitation?{limitation}:{})}:undefined;
  }
  private async restartCodexTransport(peer:Peer,endpoint:Endpoint,migration?:TransportMigration,extraReason?:string):Promise<void>{
    if(this.hooks.startupBlocked?.(peer.id))return;
    const {store}=this.environment,pair=store.pairFor(peer.id);
    if(!pair||pair.paused||peer.owner!=='nxbridge'||!peer.sessionId||this.restarting.has(peer.id)||this.retiring.has(peer.id)||this.services.takeovers.get(peer.id))return;
    const engine=this.services.managedRecovery,incident=migration?undefined:this.recoveryIncident(peer);
    if(!migration&&!extraReason&&!engine.due(incident!))return;
    const hold=(code:string,message:string)=>{
      if(migration)this.transportMigrations.hold(migration,code,message);
      else{engine.blocked(incident!,new BridgeError(code,message));this.publishRecovery(incident!,peer,message);}
    };
    if(peer.state!=='ready'){hold('session_busy','原会话仍在工作，等待安全空闲后处理连接。');return;}
    if(store.restartUnsettled(peer.id)||store.questions(true).some(question=>question.from===peer.id||question.to===peer.id)){hold('delivery_unsettled','原会话还有问题或未结算的消息，未自动停止。');return;}
    const runtime=runtimeFor(this.environment.home,{endpoint:endpoint.address})?.value;
    if(runtime?.kind!=='owned'||runtime.peerId!==peer.id||endpoint.daemon){hold('owner_unverified','该原生连接没有独立的 agybridge 启动归属，未停止共享后台或用户窗口。');return;}
    const custody=()=>{
      const current=store.peer(peer.id),currentPair=store.pairFor(peer.id);
      if(this.hooks.stopped()||current.owner!=='nxbridge'||current.sessionId!==peer.sessionId||currentPair?.id!==pair.id||currentPair.paused||!this.enabled(peer.id)||!this.enabled(pair.agy)||this.services.takeovers.get(peer.id)||this.retiring.has(peer.id)||store.setting('managedSessionConflict:'+peer.id))throw new BridgeError('session_changed','连接处理期间原会话、配对或归属已改变，未继续启动。');
    };
    this.restoringMembers.add(peer.id);
    try{
      await this.hooks.restartCodexTransport(peer,endpoint,{
        lostSocketRecovery:!migration,
        beforeStop:()=>{
          custody();const current=store.peer(peer.id),ep=store.endpoint(peer.id);
          if(!ep||ep.epoch!==endpoint.epoch||current.state!=='ready'||store.restartUnsettled(peer.id)||store.questions(true).some(question=>question.from===peer.id||question.to===peer.id))throw new BridgeError('session_busy','原会话在停止前开始工作或连接已改变，已保留原进程。');
          if(migration)this.transportMigrations.claim(migration,current,ep,pair.id);else engine.claim(incident!,extraReason);
        },
        beforeLaunch:async()=>{
          custody();await this.assertNoLiveSessionHolder(peer);custody();
          if(migration){this.transportMigrations.launching(migration);this.transportMigrations.launchGuard(migration);}
          else if(engine.get(peer.id)?.state!=='recovering')throw new BridgeError('incident_changed','原连接恢复预约已改变，未重复启动。');
        },
      });
      const replacement=store.endpoint(peer.id);
      if(migration){if(replacement)this.observeTransport(store.peer(peer.id),replacement);}
      else{engine.settled(incident!);this.publishRecovery(incident!,store.peer(peer.id),'restored same Codex session at verified idle; uncertain messages were not replayed');}
    }catch(error){
      if(migration)this.transportMigrations.failed(migration,error);
      else{
        if(incident!.attempts.length&&['restart_incomplete','timeout','runtime_launch_unconfirmed'].includes((error as BridgeError).code))engine.settled(incident!,error,true);
        else if(!['recovery_exhausted','recovery_rate_limited','recovery_uncertain','recovery_not_exhausted'].includes((error as BridgeError).code))engine.blocked(incident!,error);
        this.publishRecovery(engine.get(peer.id)!,store.peer(peer.id),'Codex socket recovery held: '+describeError(error));
      }
    }finally{this.restoringMembers.delete(peer.id);}
  }

  schedulePairedRecovery(id:string,hasPending:boolean):Promise<boolean>{
    const pending=this.memberRecoveries.get(id);if(pending)return pending;
    if(this.hooks.producersPaused()||(this.hooks.startupRecoveryBlocked??this.hooks.startupBlocked)?.(id))return Promise.resolve(false);
    const work=this.pumpStage('member_recovery:'+id,()=>this.recoverPairedPeer(id,hasPending)).finally(()=>{if(this.memberRecoveries.get(id)===work)this.memberRecoveries.delete(id);});
    this.memberRecoveries.set(id,work);return work;
  }
  deferRecoveryDelivery(id:string,recovery:Promise<boolean>):typeof SKIPPED{
    if(!this.recoveryDeliveryWaits.has(recovery)){
      this.recoveryDeliveryWaits.add(recovery);
      void recovery.then(ready=>{
        this.recoveryDeliveryWaits.delete(recovery);
        if(ready)this.background('recovery_delivery:'+id,()=>{
          const {store,adapters}=this.environment,peer=store.getPeer(id),endpoint=peer?store.endpoint(id):undefined;
          const owned=this.ownedCodexRoute(id);
          if(peer&&endpoint&&['ready','busy'].includes(peer.state)&&(!owned||adapters.codex.hasSubscription(peer,endpoint))
            &&(store.pendingCount(id)||this.services.codexDirect.pending(id)||this.services.subagentCompletions.pending(peer))){
            return this.hooks.pumpAfterCurrent();
          }
          return SKIPPED;
        });
      });
    }
    return SKIPPED;
  }
  schedulePairedRecoveries():Map<string,Promise<boolean>>{
    const recoveries=new Map<string,Promise<boolean>>();
    this.environment.store.faults.sync('member_recovery_schedule',()=>{
      const queued=new Set(this.environment.store.pendingFacts().map(message=>message.to));
      for(const pair of this.environment.store.pairs())for(const id of [pair.agy,pair.codex])recoveries.set(id,this.schedulePairedRecovery(id,queued.has(id)||id===pair.codex&&this.services.codexDirect.pending(id)));
      for(const id of this.environment.store.ongoingCodexRecycles())if(!recoveries.has(id))recoveries.set(id,this.schedulePairedRecovery(id,false));
    });
    return recoveries;
  }
  private rememberManagedLaunch(id:string):void{
    const peer=this.environment.store.peer(id);if(peer.owner!=='nxbridge'||!peer.sessionId)return;
    if(peer.host==='codex'){
      const runtime=runtimeFor(this.environment.home,{peerId:id})?.value;
      if(runtime)this.environment.store.setSetting('managedLaunchProof:'+id,{sessionId:peer.sessionId,runtimeId:runtime.id,endpoint:runtime.endpoint,pid:runtime.pid,procStart:runtime.procStart,configHome:runtime.configHome,executable:runtime.executable,profileId:runtime.profileId,version:runtime.version});
      return;
    }
    const endpoint=this.environment.store.endpoint(id);
    if(endpoint?.mode==='agy-acp'&&endpoint.configHome){
      this.environment.store.setSetting('managedLaunchProof:'+id,{sessionId:peer.sessionId,configHome:endpoint.configHome,pid:endpoint.pid,procStart:endpoint.procStart});
    }
  }
  retirements():Record<string,RetirementRecord>{return this.environment.store.setting<Record<string,RetirementRecord>>('processRetirements')??{};}
  private saveRetirements(pending:Record<string,RetirementRecord>):void{this.environment.store.setSetting('processRetirements',pending);}
  cancelRetirements(ids:readonly string[]):void{
    const pending=this.retirements();for(const id of ids)delete pending[id];this.saveRetirements(pending);
  }
  resetRetirement(id:string):void{
    const pending=this.retirements();pending[id]={attempts:0,nextAt:0};this.saveRetirements(pending);
  }
  scheduleDueRetirements():void{
    const due=Object.entries(this.retirements()).filter(([id,value])=>value.nextAt<=Date.now()&&this.enabled(id)).map(([id])=>id);
    if(due.length)this.background('retirements',()=>this.releaseOwned(due));
  }
  queueRetirements(ids:string[]):string[]{
    const {store}=this.environment;
    const pending=this.retirements();
    const release=ids.filter(id=>store.peer(id).owner==='nxbridge'&&!store.pairFor(id));
    for(const id of release)pending[id]??={attempts:0,nextAt:0};
    this.saveRetirements(pending);return release;
  }
  async releaseOwned(ids:string[]):Promise<string[]>{
    return(await Promise.all([...new Set(ids)].map(id=>{
      const active=this.releases.get(id);if(active)return active;
      this.retiring.add(id);
      const work=this.releaseMember(id).finally(()=>{this.retiring.delete(id);this.releases.delete(id);});this.releases.set(id,work);return work;
    }))).flat();
  }
  private async releaseMember(id:string):Promise<string[]>{
    const {store,adapters}=this.environment;
    if(!this.enabled(id))return[];
    await this.preparing.get(id)?.catch(()=>{});
    while(this.restarting.has(id))await delay(20);
    const pair=store.pairFor(id),peer=store.peer(id);
    let failure:unknown;
    const guard=()=>{
      const current=store.getPeer(id);
      if(!current||current.owner!=='nxbridge'||current.sessionId!==peer.sessionId||!memberEnabled(store,current)||store.pairFor(id)||
        store.bindings.current(id)||this.services.takeovers.get(id))
        throw new BridgeError('retirement_authority_changed','成员归属已变化，保留后台。');
    };
    try{
      if(peer.owner!=='nxbridge'||pair||!memberEnabled(store,peer))return[];
      if(this.services.takeovers.get(id))throw new BridgeError('foreground_active','接管窗口仍存活，未回收后台。');
      const ep=store.endpoint(id)??store.endpoints(id).filter(value=>value.mode==='app-server').sort((a,b)=>b.seenAt-a.seenAt)[0];
      this.rememberManagedLaunch(id);
      if(peer.host==='agy'){
        await adapters.agy.release(peer);
      }else{
        guard();if(ep)await adapters.codex.release(peer,ep,guard);guard();
      }
      store.deactivate(id);store.updatePeer(id,{state:'offline'});
      if(peer.host==='codex'){
        const references=store.peers().filter(value=>(value.owner==='user'||!!store.pairFor(value.id))&&!(value.host==='codex'&&value.kind==='subagent')).flatMap(value=>store.endpoints(value.id));
        const note=await adapters.codex.releaseRuntime(references,ep?.address,[peer],{guard,runtimeId:ep?.runtimeId});
        if(note)throw new BridgeError('runtime_release_pending',note);
        const stage=this.services.managedRecovery.get(peer.id)?.recycle,paused=stage?.phase==='held'?stage.paused:stage;
        const replacement=paused?.phase==='verifying'?paused.fresh:paused?.phase==='retiring'?paused.verification.fresh:undefined;
        if(replacement&&ep&&replacement.runtimeId!==ep.runtimeId){
          const target={id:replacement.runtimeId};
          const guardReplacement=()=>{
            guard();
            const runtime=runtimeFor(this.environment.home,target)?.value;
            if(store.endpoints().some(route=>route.active&&route.address===replacement.endpoint)||
              runtime?.kind!=='owned'||!runtime.dedicated||runtime.peerId!==id||runtime.sessionId!==peer.sessionId||runtime.endpoint!==replacement.endpoint||
              runtime.pid!==replacement.pid||runtime.procStart!==replacement.procStart||runtime.bootId!==replacement.bootId)
              throw new BridgeError('retirement_authority_changed','替代后台归属已变化，保留后台。');
          };
          if(runtimeFor(this.environment.home,target)){
            guardReplacement();
            const held=await adapters.codex.releaseRuntime(references,replacement.endpoint,[peer],{runtimeId:replacement.runtimeId,guard:guardReplacement});
            if(held)throw new BridgeError('runtime_release_pending',held);
          }
        }
      }
    }catch(error){if(!(error instanceof BridgeError)||error.code!=='retirement_authority_changed')failure=error;}
    finally{
      const pending=this.retirements();
      const current=store.getPeer(id),disabled=current?.owner==='nxbridge'&&current.sessionId===peer.sessionId&&!store.pairFor(id)&&!memberEnabled(store,current);
      if(!disabled){
        if(failure){const attempts=(pending[id]?.attempts??0)+1,wait=[0,30000,120000][attempts]??120000,exhausted=attempts>=3||(failure instanceof BridgeError&&failure.code==='agy_release_unresolved');pending[id]={attempts,nextAt:exhausted?Number.MAX_SAFE_INTEGER:Date.now()+wait,error:describeError(failure)};store.event('release.failed',{peerId:id,retryInMs:exhausted?null:wait,exhausted,error:describeError(failure)});}
        else delete pending[id];
        this.saveRetirements(pending);
      }
    }
    return failure?[`${peer.name} 回收未完成：${describeError(failure)}`]:[];
  }
}
