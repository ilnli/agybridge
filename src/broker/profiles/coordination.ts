import type { Store } from '../../storage/store.js';
import type { BridgeConfig, ModelProfile, Peer } from '../../types.js';
import type { CodexAdapter } from '../../hosts/codex/adapter.js';
import type { AgyAdapter } from '../../hosts/agy/adapter.js';
import { BridgeError, describeError } from '../../shared/errors.js';
import { hostingGate } from '../recovery/session-hosting.js';
import { PartnerProfiles, codexProfileSchema, hasProfile, type EffectiveModelProfile } from './partner-profile.js';
import { syncFrozenProfiles } from './frozen-profile.js';

interface ProfileEnvironment {
  readonly store:Store;
  readonly config:BridgeConfig;
  readonly adapters:{
    readonly codex:Pick<CodexAdapter,'modelProfile'|'setProfile'|'readProfile'>;
    readonly agy:Pick<AgyAdapter,'modelProfile'|'setProfile'|'readProfile'>;
  };
  readonly home:string;
}
interface ProfileLifecycle {
  stopped:boolean;enabled:boolean;preparing:boolean;restarting:boolean;retiring:boolean;takingOver:boolean;
}
interface ProfileHooks {
  lifecycle:(id:string)=>ProfileLifecycle;
  beginChange:(id:string)=>()=>void;
  pump:()=>Promise<void>;
}

export class PartnerProfileCoordination {
  readonly profiles:PartnerProfiles;
  private profileChecks=new Map<string,number>();
  private profileStages=new Set<string>();
  constructor(private readonly environment:ProfileEnvironment,private readonly hooks:ProfileHooks){
    const {store,home,config,adapters}=environment;
    syncFrozenProfiles(home,config);this.profiles=new PartnerProfiles(store,home,config);this.profiles.syncConfiguration();
    adapters.codex.modelProfile=peer=>this.profiles.requested(peer);
    adapters.agy.modelProfile=peer=>this.profiles.requested(peer);
  }
  async apply(peer:Peer):Promise<void>{
    const {store,adapters}=this.environment,intent=this.profiles.intent(peer),pair=store.pairFor(peer.id),endpoint=store.endpoint(peer.id);
    if(!intent||intent.status!=='pending'||!intent.sessionId||!hasProfile(intent.requested)||peer.owner!=='nxbridge'||peer.state!=='ready'||!endpoint||!pair||pair.paused)return;
    const state=this.hooks.lifecycle(peer.id);
    if(!state.enabled||state.preparing||state.restarting||state.retiring||state.takingOver||hostingGate(store,peer))return;
    const release=this.hooks.beginChange(peer.id);
    const guard=()=>{
      const current=store.peer(peer.id),ep=store.endpoint(peer.id),latest=this.profiles.intent(current),state=this.hooks.lifecycle(peer.id);
      if(state.stopped||!state.enabled||current.owner!=='nxbridge'||current.sessionId!==peer.sessionId||store.pairFor(peer.id)?.id!==pair.id||ep?.epoch!==endpoint.epoch||ep.address!==endpoint.address||latest?.at!==intent.at||JSON.stringify(latest.requested)!==JSON.stringify(intent.requested)||state.takingOver)throw new BridgeError('session_changed','切换期间搭档、会话或所选设置有变化，这次没有切换。');
    };
    try{
      guard();
      const actual=await adapters[peer.host].setProfile(peer,endpoint,intent.requested,guard);guard();
      this.profiles.applied(peer,actual);store.event('partner.profile.applied',{peerId:peer.id,sessionId:peer.sessionId,...actual});
    }catch(error){if((error as BridgeError).code!=='session_busy'){
      if(this.profiles.intent(peer)?.at===intent.at)this.profiles.failed(peer,error);
      store.event('partner.profile.failed',{peerId:peer.id,error:describeError(error)});
    }}finally{release();}
  }
  async verifyInitial(peer:Peer,_wait=false):Promise<void>{
    const {store,adapters}=this.environment,intent=this.profiles.intent(peer);
    if(peer.owner!=='nxbridge'||!peer.sessionId||!intent||intent.sessionId||intent.status!=='pending'||!hasProfile(intent.requested))return;
    try{
      const endpoint=store.endpoint(peer.id);if(!endpoint)return;
      const guard=()=>{if(store.peer(peer.id).sessionId!==peer.sessionId)throw new BridgeError('session_changed','启动设置核验期间会话已改变。');};
      const actual:EffectiveModelProfile=peer.host==='codex'
        ?await adapters.codex.readProfile(peer,endpoint,guard)
        :await adapters.agy.readProfile(peer,endpoint,guard);
      if(this.profiles.intent(peer)?.at!==intent.at)return;
      const current=store.peer(peer.id),state=this.hooks.lifecycle(peer.id);
      if(current.sessionId!==peer.sessionId||current.owner!=='nxbridge'||state.stopped||!state.enabled)throw new BridgeError('session_changed','启动设置回读期间会话或归属已改变，任务未提交。');
      this.profiles.applied(current,actual);
    }catch(error){if(this.profiles.intent(peer)?.at===intent.at){
      if((error as BridgeError).code==='profile_verification_failed')this.profiles.failed(peer,error);else this.profiles.waiting(peer,error);
    }}
  }
  async synchronize(id:string):Promise<void>{
    if(this.profileStages.has(id))return;
    this.profileStages.add(id);
    try{await this.verifyInitial(this.environment.store.peer(id));await this.reconcile(this.environment.store.peer(id));await this.apply(this.environment.store.peer(id));}
    finally{this.profileStages.delete(id);}
  }
  async reconcile(peer:Peer):Promise<void>{
    const {store,adapters}=this.environment,intent=this.profiles.intent(peer),endpoint=store.endpoint(peer.id),pair=store.pairFor(peer.id);
    if(!intent||!hasProfile(intent.requested)||peer.owner!=='nxbridge'||!endpoint||peer.state!=='ready'||!pair||pair.paused)return;
    const state=this.hooks.lifecycle(peer.id);
    if(!state.enabled||state.restarting||state.retiring||state.takingOver||hostingGate(store,peer)||intent.status==='pending'||!this.profiles.blocks(peer)||(this.profileChecks.get(peer.id)??0)>Date.now())return;
    this.profileChecks.set(peer.id,Date.now()+5000);
    const context=this.profiles.context(peer);
    const guard=()=>{const current=store.peer(peer.id),state=this.hooks.lifecycle(peer.id);if(state.stopped||!state.enabled||current.owner!=='nxbridge'||this.profiles.context(current)!==context||store.pairFor(peer.id)?.id!==pair.id||store.pairFor(peer.id)?.paused||state.restarting||state.retiring||state.takingOver||this.profiles.intent(peer)?.at!==intent.at)throw new BridgeError('session_changed','设置核对期间会话已改变。');};
    try{
      guard();
      const actual=peer.host==='codex'
        ?await adapters.codex.readProfile(peer,endpoint,guard)
        :await adapters.agy.readProfile(peer,endpoint,guard);
      guard();if(actual)this.profiles.applied(store.peer(peer.id),actual);
    }catch(error){if((error as BridgeError).code==='profile_verification_failed')this.profiles.failed(peer,error);else this.profiles.waiting(peer,error);}
  }
  async command(peer:Peer,action:'get'|'set'|'reset',profile:ModelProfile):Promise<unknown>{
    if(profile.serviceTier!==undefined&&(peer.host!=='codex'||action!=='set'))throw new BridgeError('invalid_arguments','service_tier 只能用于修改 Codex 后台搭档。');
    if(action!=='get'){
      if(peer.owner!=='nxbridge')throw new BridgeError('process_owned_by_user','只能修改 agybridge 自己启动的后台搭档的模型和推理强度；你自己打开的窗口请在那个窗口里设置。');
      if(action==='set'&&!hasProfile(profile))throw new BridgeError('invalid_arguments','修改时至少要指定模型、推理强度或 Codex 服务档位其中一项。');
      this.profiles.set(peer,codexProfileSchema.parse(profile),action==='reset');await this.apply(peer);
      queueMicrotask(()=>void this.hooks.pump());
    }
    return{member_id:peer.id,host:peer.host,session_id:peer.sessionId,...this.profiles.view(this.environment.store.peer(peer.id))};
  }
}
