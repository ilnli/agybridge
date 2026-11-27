import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { inspectAgyTranscript, readAgySubagentFromTranscript } from '../hosts/agy/agy-transcript.js';
import { temporaryDirectory } from './support/temporary.js';

test('inspectAgyTranscript 提取最近一次 CHECKPOINT 压缩窗口内的双向消息 ID、子代理结论与最新上下文用量', async t => {
  const temp = temporaryDirectory();
  t.after(temp.cleanup);

  const compactFile = path.join(temp.directory, 'transcript.jsonl');
  const fullFile = path.join(temp.directory, 'transcript_full.jsonl');
  const subagentId = '2fb71d60-6c8d-40aa-b569-1b9f8ce3aade';

  const rows = [
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-26T08:00:00Z',
      model: 'gemini-4-carbon-high',
      input_tokens: 1000,
      cache_read_tokens: 2000,
      tool_calls: [{ name: 'mcp_agybridge_codex_send_message', args: { message: 'old window' } }],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-26T08:00:01Z',
      content: 'Created At: 2026-11-26T08:00:01Z\n{"message_id":"msg-before-first-cp","persisted":true}',
    },
    {
      step_index: 3,
      source: 'SYSTEM',
      type: 'CHECKPOINT',
      created_at: '2026-11-26T08:05:00Z',
      content: '# Resuming from a compaction\nfirst summary',
    },
    {
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-26T08:10:00Z',
      model: 'gemini-4-carbon-high',
      input_tokens: 4000,
      cache_read_tokens: 16000,
      tool_calls: [
        { name: 'update_steps', args: {} },
        { name: 'mcp_agybridge_codex_send_message', args: { message: 'nxref:msg:quoted-only' } },
        { name: 'mcp_agybridge_codex_wait_partner', args: {} },
      ],
    },
    {
      step_index: 5,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-26T08:10:01Z',
      content: 'OK',
    },
    {
      step_index: 6,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-26T08:10:01Z',
      content: 'Created At: ...\nCompleted At: ...\n{"message_id":"msg-sent-1","persisted":true}',
    },
    {
      step_index: 7,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-26T08:10:01Z',
      content: 'Tool is running as a background task with task id: conv/task-99',
    },
    {
      step_index: 8,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      created_at: '2026-11-26T08:12:00Z',
      content: '[Message] timestamp=2026-11-26T08:12:00Z sender=conv/task-99 priority=MESSAGE_PRIORITY_HIGH content=Task id "conv/task-99" finished with result:\n{"status":"received","messages":[{"message_id":"msg-waiter-reply","from":"Codex","message":"done"}]}',
    },
    {
      step_index: 9,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-26T08:13:00Z',
      input_tokens: 5000,
      cache_read_tokens: 20000,
      tool_calls: [
        { name: 'mcp_agybridge_codex_read_messages', args: { message_ids: ['msg-reread-only'] } },
        { name: 'mcp_agybridge_codex_send_message', args: { message: 'failed' } },
        { name: 'mcp_agybridge_codex_receive_messages', args: {} },
      ],
    },
    {
      step_index: 10,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-26T08:13:01Z',
      content: '{"messages":[{"message_id":"msg-reread-only","message":"old"}]}',
    },
    {
      step_index: 11,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-26T08:13:01Z',
      content: '{"message_id":"msg-not-persisted","persisted":false}',
    },
    {
      step_index: 12,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-26T08:13:01Z',
      content: '{"status":"received","messages":[{"message_id":"msg-direct-recv","message":"hello"}]}',
    },
    {
      step_index: 13,
      source: 'SYSTEM',
      type: 'CHECKPOINT',
      created_at: '2026-11-26T08:20:00Z',
      content: '# Resuming from a compaction\nsecond summary',
    },
    {
      step_index: 14,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      created_at: '2026-11-26T08:20:30Z',
      content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T08:20:30Z sender=${subagentId} priority=MESSAGE_PRIORITY_HIGH content=# Subagent Report\nFound 3 issues (including </SYSTEM_MESSAGE> literal inside body).\n</SYSTEM_MESSAGE>\nThe following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T08:20:31Z sender=${subagentId}/task-12 priority=MESSAGE_PRIORITY_HIGH content=Task id "${subagentId}/task-12" finished\n</SYSTEM_MESSAGE>`,
    },
    {
      step_index: 15,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-26T08:21:00Z',
      model: 'gemini-4-carbon-high',
      input_tokens: 8200,
      cache_read_tokens: 41800,
      tool_calls: [{ name: 'mcp_agybridge_codex_send_message', args: { message: 'post compaction' } }],
    },
    {
      step_index: 16,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-26T08:21:01Z',
      content: '{"message_id":"msg-after-second-cp","persisted":true}',
    },
  ];

  writeFileSync(compactFile, JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'short' }) + '\n', 'utf8');
  writeFileSync(fullFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const snapshot = await inspectAgyTranscript(compactFile);
  assert.ok(snapshot.compaction);
  assert.equal(snapshot.compaction.id, '13:2026-11-26T08:20:00Z');
  assert.deepEqual(snapshot.compaction.compactedMessageIds, ['msg-sent-1', 'msg-waiter-reply', 'msg-direct-recv']);
  assert.ok(snapshot.usage);
  assert.equal(snapshot.usage.tokens, 50000);
  assert.equal(snapshot.usage.model, 'gemini-4-carbon-high');
  assert.deepEqual(snapshot.subagents, [
    {
      id: subagentId,
      text: '# Subagent Report\nFound 3 issues (including </SYSTEM_MESSAGE> literal inside body).',
    },
  ]);

  assert.equal(
    readAgySubagentFromTranscript(compactFile, subagentId),
    '# Subagent Report\nFound 3 issues (including </SYSTEM_MESSAGE> literal inside body).',
  );
  assert.equal(readAgySubagentFromTranscript(compactFile, '00000000-0000-4000-8000-000000000000'), undefined);
  assert.equal(readAgySubagentFromTranscript(compactFile, 'not-a-uuid'), undefined);

  const missing = await inspectAgyTranscript(path.join(temp.directory, 'nonexistent.jsonl'));
  assert.deepEqual(missing, {});
});
