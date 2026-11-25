import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { persistentSocketDirectory } from '../process/posix/persistent-socket-directory.js';
import { temporaryDirectory } from './support/temporary.js';

const posix = { skip: process.platform === 'win32' };
const name = 'ci-0123456789abcdef.sock';

test('持久 Unix socket 地址优先使用各自归属目录，按 UTF-8 字节判定后备位置', posix, t => {
  const fixture = temporaryDirectory('/tmp'), userHome = fixture.directory, home = path.join(userHome, 'bridge');
  t.after(fixture.cleanup);
  const local = persistentSocketDirectory(home, name, userHome);
  assert.equal(local, path.join(home, 'run'));
  assert.equal(lstatSync(local).mode & 0o777, 0o700);
  const longHome = path.join(userHome, '长'.repeat(40));
  const fallback = persistentSocketDirectory(longHome, name, userHome);
  assert.equal(path.dirname(fallback), userHome);
  assert.match(path.basename(fallback), /^\.nxb-[a-f0-9]{12}$/);
  assert.equal(lstatSync(fallback).mode & 0o777, 0o700);
  assert.ok(Buffer.byteLength(path.join(fallback, name)) <= 103);
  assert.equal(persistentSocketDirectory(longHome, name, userHome), fallback);
  assert.notEqual(persistentSocketDirectory(longHome+'2', name, userHome), fallback);
  assert.equal(existsSync(longHome), false);
  assert.throws(() => persistentSocketDirectory(longHome, name, longHome), { code: 'socket_path_too_long' });
});

test('持久 Unix socket 目录升级旧权限并拒绝更改目录链接的目标', posix, t => {
  const fixture = temporaryDirectory('/tmp'), home = fixture.directory, loose = path.join(home, 'loose'), linked = path.join(home, 'linked');
  t.after(fixture.cleanup);
  const looseRun = path.join(loose, 'run'), linkedRun = path.join(linked, 'run');
  mkdirSync(looseRun, { recursive: true });
  chmodSync(looseRun, 0o755);
  mkdirSync(linked);
  symlinkSync(looseRun, linkedRun);
  assert.throws(() => persistentSocketDirectory(linked, name, home), { code: 'socket_directory_conflict' });
  assert.equal(lstatSync(looseRun).mode & 0o777, 0o755);
  assert.ok(lstatSync(linkedRun).isSymbolicLink());
  assert.equal(persistentSocketDirectory(loose, name, home), looseRun);
  assert.equal(lstatSync(looseRun).mode & 0o777, 0o700);
});
