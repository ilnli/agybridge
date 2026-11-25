import test from 'node:test';
import assert from 'node:assert/strict';
import { platformCompatibility, versionCompatibility, requireCodexVersion } from '../install/compatibility.js';
import { ownedSocketDirectory } from '../shared/local-paths.js';

test('版本按数字比较，Codex 最低为 0.164，AGY 保留能力预检',()=>{
  for(const version of ['codex-cli 0.99.0','codex-cli 0.163.9','unknown'])assert.throws(()=>requireCodexVersion(version),{code:'codex_version'});
  for(const version of ['codex-cli 0.164.0','codex-cli 0.166.0','codex-cli 0.200.0'])assert.doesNotThrow(()=>requireCodexVersion(version));
  assert.equal(versionCompatibility('codex','codex-cli 0.99.0').status,'older-than-tested');
  assert.equal(versionCompatibility('codex','codex-cli 0.164.0').status,'tested');
  assert.equal(versionCompatibility('codex','codex-cli 0.165.0').status,'untested');
  assert.equal(versionCompatibility('codex','codex-cli 0.200.0').status,'untested');
  assert.equal(versionCompatibility('codex','codex-cli 0.172.0').status,'tested');
  assert.equal(versionCompatibility('agy','1.5.17').status,'tested');
  assert.equal(versionCompatibility('agy','1.5.14').status,'tested');
  assert.equal(versionCompatibility('agy','1.0.0').status,'older-than-tested');
  assert.equal(versionCompatibility('agy','unknown').status,'unrecognized');
  assert.match(versionCompatibility('agy','1.0.0').notice,/不会仅因版本号拒绝/);
});

test('macOS 明确未验收',()=>{
  assert.equal(platformCompatibility('darwin').accepted,false);assert.match(platformCompatibility('darwin').notice,/尚未完成实机验收/);
});

test('macOS 长 HOME、中文路径和长 TMPDIR 均为实际最长 socket 文件名保留空间',()=>{
  for(const home of ['/Users/example1/.agybridge','/Users/'+'用户'.repeat(30)+'/.agybridge']){
    const directory=ownedSocketDirectory(home,'/var/folders/xx/'+'y'.repeat(70)+'/T','darwin');
    for(const file of ['broker.sock','cc-0123456789abcdef.sock','codex-mvxg9dea.sock'])assert.ok(Buffer.byteLength(directory+'/'+file)<100);
    if(home.includes('用户'))assert.match(directory,/^\/tmp\/agb-/);
  }
});
