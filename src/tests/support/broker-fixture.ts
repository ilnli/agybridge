import type { TestContext } from 'node:test';
import { Store } from '../../storage/store.js';
import { Broker, type Adapters } from '../../broker/coordinator.js';
import type { BrokerLifecycleCoordinator } from '../../broker/lifecycle/coordinator.js';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
import { type BridgeConfig } from '../../types.js';
import type { ResourceHealth } from '../../broker/health/resource-health.js';
import { FakeAdapter } from './fake-adapter.js';
import { registration } from './registration.js';
import { temporaryDirectory } from './temporary.js';

export function lifecycle(broker:Broker):BrokerLifecycleCoordinator{return (broker as unknown as {memberLifecycle:BrokerLifecycleCoordinator}).memberLifecycle;}

export function fixture(t:TestContext,overrides:Partial<BridgeConfig>={},resources?:ResourceHealth){
  const tmp=temporaryDirectory(),home=tmp.directory,store=new Store(':memory:');
  const codex=new FakeAdapter(),agy=new FakeAdapter();
  const broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'never',codexBinary:process.execPath,agyBinary:process.execPath,codexHome:home,agyHome:home,...overrides},{codex,agy} as unknown as Adapters,home,undefined,undefined,resources);
  t.after(async()=>{await broker.stop();store.close();await tmp.cleanup();});
  const agyInput=registration('agy','c');agyInput.endpoint.configHome=home;
  const a=store.register(agyInput),x=store.register(registration('codex','x'));
  return{store,broker,a,c:a,x,codex,agy};
}
