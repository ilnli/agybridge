import { closeSync, createReadStream, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

export interface AgyCompactionWindow {
  id: string;
  at: number;
  compactedMessageIds: string[];
}

export interface AgyTranscriptUsage {
  tokens: number;
  at: number;
  model?: string;
}

export interface AgySubagentDelivery {
  id: string;
  text: string;
}

export interface AgyTranscriptSnapshot {
  compaction?: AgyCompactionWindow;
  usage?: AgyTranscriptUsage;
  subagents?: AgySubagentDelivery[];
}

type ToolExchange = 'send' | 'receive' | 'other';

const MAX_COMPACTION_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_SUBAGENT_SCAN_BYTES = 16 * 1024 * 1024;
const USAGE_ONLY_TAIL_BYTES = 256 * 1024;
const SUBAGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBAGENT_BLOCK_RE = /<SYSTEM_MESSAGE>\s*\[Message\]\s+timestamp=\S+\s+sender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+priority=\S+\s+content=([\s\S]*?)\s*<\/SYSTEM_MESSAGE>(?=\s*(?:$|The following is a <SYSTEM_MESSAGE>|<SYSTEM_MESSAGE>))/gi;
const SUBAGENT_RAW_RE = /^\[Message\]\s+timestamp=\S+\s+sender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+priority=\S+\s+content=([\s\S]+)$/i;

export function resolveAgyTranscriptFile(transcriptPath: string): string {
  if (path.basename(transcriptPath) === 'transcript.jsonl') {
    const full = path.join(path.dirname(transcriptPath), 'transcript_full.jsonl');
    if (existsSync(full)) return full;
  }
  return transcriptPath;
}

function extractSubagentDeliveries(content: string): AgySubagentDelivery[] {
  const results: AgySubagentDelivery[] = [];
  if (content.includes('<SYSTEM_MESSAGE>')) {
    for (const match of content.matchAll(SUBAGENT_BLOCK_RE)) {
      const id = match[1]!;
      const body = match[2]!.trim();
      if (body) results.push({ id, text: body });
    }
    return results;
  }
  const raw = SUBAGENT_RAW_RE.exec(content.trim());
  if (raw && raw[2]!.trim()) results.push({ id: raw[1]!, text: raw[2]!.trim() });
  return results;
}

function classifyAgyTool(toolCall: unknown): ToolExchange {
  if (!toolCall || typeof toolCall !== 'object') return 'other';
  const name = typeof (toolCall as { name?: unknown }).name === 'string' ? (toolCall as { name: string }).name : '';
  if (/^(?:mcp_(?:agybridge_)?)?codex(?:__|_|[.:])send_message$/.test(name)) return 'send';
  if (/^(?:mcp_(?:agybridge_)?)?codex(?:__|_|[.:])(?:receive_messages|wait_partner)$/.test(name)) return 'receive';
  return 'other';
}

function addId(ids: Set<string>, raw: unknown): void {
  if (typeof raw === 'string' && raw.length > 0 && raw.length <= 128) ids.add(raw);
}

function extractExchangeIdsFromText(text: string, kind: 'send' | 'receive', ids: Set<string>): void {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    if (kind === 'send' && parsed.persisted === true) {
      addId(ids, parsed.message_id);
    } else if (kind === 'receive' && Array.isArray(parsed.messages)) {
      for (const message of parsed.messages) {
        if (typeof message?.message === 'string') addId(ids, message.message_id);
      }
    }
  }
}

function parseTimestamp(raw: unknown): number {
  if (typeof raw === 'string' && raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

async function scanTailWindow(file: FileHandle, size: number, check: () => void): Promise<number> {
  const minOffset = Math.max(0, size - MAX_COMPACTION_SCAN_BYTES);
  let position = size;
  let checkpoints = 0;
  let fragments: Buffer[] = [];
  let earliestLineStart = size;

  const isCheckpoint = (parts: Buffer[]): boolean => {
    const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
    if (!line.includes('"CHECKPOINT"')) return false;
    try {
      return JSON.parse(line.toString('utf8'))?.type === 'CHECKPOINT';
    } catch {
      return false;
    }
  };

  while (position > minOffset) {
    check();
    const start = Math.max(minOffset, position - 64 * 1024);
    const chunk = Buffer.allocUnsafe(position - start);
    const { bytesRead } = await file.read(chunk, 0, chunk.length, start);
    check();
    let end = bytesRead;
    for (let newline = chunk.lastIndexOf(10, end - 1); newline >= 0; newline = chunk.lastIndexOf(10, end - 1)) {
      check();
      const lineOffset = start + newline + 1;
      const parts = [chunk.subarray(newline + 1, end), ...fragments.toReversed()];
      fragments = [];
      earliestLineStart = lineOffset;
      if (isCheckpoint(parts) && ++checkpoints === 2) return lineOffset;
      end = newline;
      if (!end) break;
    }
    fragments.push(chunk.subarray(0, end));
    position = start;
  }

  if (checkpoints === 0) {
    if (size <= USAGE_ONLY_TAIL_BYTES) return 0;
    const usageStart = Math.max(0, size - USAGE_ONLY_TAIL_BYTES);
    const probe = Buffer.allocUnsafe(Math.min(4096, size - usageStart));
    const { bytesRead } = await file.read(probe, 0, probe.length, usageStart);
    const firstNewline = probe.subarray(0, bytesRead).indexOf(10);
    return firstNewline >= 0 ? usageStart + firstNewline + 1 : usageStart;
  }

  return minOffset === 0 ? 0 : earliestLineStart;
}

export async function inspectAgyTranscript(transcriptPath: string, budgetMs = 2500): Promise<AgyTranscriptSnapshot> {
  const target = resolveAgyTranscriptFile(transcriptPath);
  if (!existsSync(target)) return {};
  const deadline = performance.now() + budgetMs;
  const signal = AbortSignal.timeout(Math.max(1, budgetMs));
  const check = () => {
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw new Error('AGY 转录读取超过时间预算');
  };
  check();
  const file = await open(target, 'r');
  let size = 0;
  let start = 0;
  try {
    size = (await file.stat()).size;
    if (!size) return {};
    start = await scanTailWindow(file, size, check);
  } finally {
    await file.close();
  }
  check();

  let ids = new Set<string>();
  let pendingTools: ToolExchange[] = [];
  let compaction: AgyCompactionWindow | undefined;
  let usage: AgyTranscriptUsage | undefined;
  const subagents = new Map<string, string>();

  const stream = createReadStream(target, { encoding: 'utf8', start, end: size - 1, signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      check();
      if (!line.trim()) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || typeof row !== 'object') continue;

      if (row.type === 'PLANNER_RESPONSE') {
        pendingTools = Array.isArray(row.tool_calls) ? row.tool_calls.map(classifyAgyTool) : [];
        const inputTokens = Number.isSafeInteger(row.input_tokens) && row.input_tokens >= 0 ? row.input_tokens : undefined;
        const cacheTokens = Number.isSafeInteger(row.cache_read_tokens) && row.cache_read_tokens >= 0 ? row.cache_read_tokens : 0;
        if (inputTokens !== undefined) {
          usage = {
            tokens: inputTokens + cacheTokens,
            at: parseTimestamp(row.created_at),
            ...(typeof row.model === 'string' && row.model ? { model: row.model } : {}),
          };
        }
        continue;
      }

      if (row.type === 'GENERIC' && row.source === 'MODEL') {
        const kind = pendingTools.shift();
        if ((kind === 'send' || kind === 'receive') && typeof row.content === 'string') {
          extractExchangeIdsFromText(row.content, kind, ids);
        }
        continue;
      }

      if (row.type === 'SYSTEM_MESSAGE' && typeof row.content === 'string') {
        if (row.content.includes('finished with result:')) {
          extractExchangeIdsFromText(row.content, 'receive', ids);
        }
        if (row.content.includes('[Message]') && row.content.includes('sender=')) {
          for (const delivery of extractSubagentDeliveries(row.content)) {
            subagents.set(delivery.id.toLowerCase(), delivery.text);
          }
        }
        continue;
      }

      if (row.type === 'CHECKPOINT') {
        const stepPart = row.step_index !== undefined ? String(row.step_index) : 'checkpoint';
        const timePart = typeof row.created_at === 'string' ? row.created_at : '';
        compaction = {
          id: `${stepPart}:${timePart}`,
          at: parseTimestamp(row.created_at),
          compactedMessageIds: [...ids],
        };
        ids = new Set();
        pendingTools = [];
        usage = undefined;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  return {
    ...(compaction ? { compaction } : {}),
    ...(usage ? { usage } : {}),
    ...(subagents.size ? { subagents: [...subagents.entries()].map(([id, text]) => ({ id, text })) } : {}),
  };
}

export function readAgySubagentFromTranscript(transcriptPath: string, agentId: string): string | undefined {
  if (!SUBAGENT_ID_RE.test(agentId)) return undefined;
  const target = resolveAgyTranscriptFile(transcriptPath);
  if (!existsSync(target)) return undefined;
  const wanted = agentId.toLowerCase();
  const needle = `sender=${wanted}`;
  const fd = openSync(target, 'r');
  try {
    const size = fstatSync(fd).size;
    if (!size) return undefined;
    const minOffset = Math.max(0, size - MAX_SUBAGENT_SCAN_BYTES);
    let position = size;
    let fragments: Buffer[] = [];

    const checkLine = (parts: Buffer[]): string | undefined => {
      const lineBuf = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
      const line = lineBuf.toString('utf8');
      if (!line.toLowerCase().includes(needle)) return undefined;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        return undefined;
      }
      if (row?.type !== 'SYSTEM_MESSAGE' || typeof row.content !== 'string') return undefined;
      const deliveries = extractSubagentDeliveries(row.content).filter(d => d.id.toLowerCase() === wanted);
      return deliveries.at(-1)?.text;
    };

    while (position > minOffset) {
      const start = Math.max(minOffset, position - 64 * 1024);
      const chunk = Buffer.allocUnsafe(position - start);
      const bytesRead = readSync(fd, chunk, 0, chunk.length, start);
      let end = bytesRead;
      for (let newline = chunk.lastIndexOf(10, end - 1); newline >= 0; newline = chunk.lastIndexOf(10, end - 1)) {
        const parts = [chunk.subarray(newline + 1, end), ...fragments.toReversed()];
        fragments = [];
        const found = checkLine(parts);
        if (found !== undefined) return found;
        end = newline;
        if (!end) break;
      }
      fragments.push(chunk.subarray(0, end));
      position = start;
    }

    if (fragments.length && minOffset === 0) {
      return checkLine(fragments.toReversed());
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}
