import test from 'node:test';
import assert from 'node:assert/strict';
import { codexDeliveryHoldText, TAKEOVER_VERIFY_STEPS, type CodexDeliveryHoldCode } from '../broker/delivery/codex-delivery-hold-text.js';
import { formatStatus } from '../integration/mcp/presentation.js';

const hold = (code: CodexDeliveryHoldCode) => ({ code, ...codexDeliveryHoldText(code) });

test('后台 Codex 正在工作时模型与状态文本分别提供紧凑英文原因和中文暂缓说明', () => {
  const busy = hold('session_busy');
  assert.equal(busy.model, 'queued: partner busy; picked up at its next tool call or turn end');
  assert.match(busy.status, /对方正在工作/);
  const pendingUser = hold('pending_user');
  assert.match(pendingUser.status, /对方在等你批准操作或回答问题/);
  const takeoverUnverified = hold('takeover_unverified');
  assert.match(takeoverUnverified.status, /没法确认是 agybridge 打开的/);
});

test('agybridge status 写出消息暂缓的原因，对方正在工作也写', () => {
  const peer = (name: string, extra: object = {}) => ({ id: name, name, host: name, state: 'busy', ...extra });
  const text = formatStatus({ paired: true, pending: 1, questions: [], self: peer('agy'),
    partner: peer('codex', { hosting: { phase: 'background', held_unsent: 1, delivery_hold: hold('session_busy') } }) });
  assert.match(text, /消息暂缓：对方正在工作，下次调用工具或这一轮结束时会取到/);
});

test('原会话记录暂时核对不全时只说证据不够，不请用户改设置', () => {
  const step = TAKEOVER_VERIFY_STEPS.restart_profile_unverified;
  assert.match(step, /暂时没法完整核对/);
  assert.doesNotMatch(step, /改回|--reset/);
});
