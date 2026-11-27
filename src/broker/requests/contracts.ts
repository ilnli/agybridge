import {z} from 'zod';

export const text=z.string().min(1).max(262144);
export const host=z.enum(['agy','codex']);
export const actorSchema=z.object({host,memberId:text.optional(),sessionId:text,callId:text,via:z.string().optional(),turnId:text.optional(),binding:z.object({key:text,epoch:text}).optional()});
export const targetSchema=z.object({actor:actorSchema.optional(),pair_id:text.optional(),peer_id:text.optional(),session_id:text.optional(),native:z.object({host,pid:z.number().int().positive(),procStart:text}).optional()});
export const restartSchema=targetSchema.extend({partner:z.literal(true).optional()});
export const profileSchema=z.object({model:z.string().min(1).nullable().optional(),effort:z.union([z.string().min(1),z.number().finite()]).nullable().optional(),serviceTier:z.string().min(1).nullable().optional()});
export const processSchema=z.object({pid:z.number().int().positive(),procStart:text});
export const nativeSessionSchema=z.object({
  transcriptPath:text.optional(),
  transcriptPathFallback:z.boolean().optional(),
  artifactsDir:text.optional(),
  interactive:z.boolean().optional(),
}).strict();

const nativePermissionSchema=z.object({
  permission:z.enum(['prompting','bypass','unknown']),
  mode:z.string().min(1).optional(),
  observedAt:z.number().finite(),
});

const count=z.number().int().safe().nonnegative();
const at=z.number().finite().nonnegative();
const turnId=z.string().min(1).max(256);

export const nativeBackgroundSchema=z.object({
  tasks:count.optional(),
  crons:count.optional(),
  observedAt:at,
}).strict();

export const turnStatsSchema=z.object({
  startedAt:at,
  covered:z.boolean(),
  actions:count,
  workTools:count,
  lastWorkAt:at.optional(),
  partnerDriven:z.boolean().optional(),
  partnerMessageIds:z.array(z.string().min(1).max(128)).max(16).optional(),
}).strict();
export const turnBackgroundSchema=z.object({tasks:count.optional(),crons:count.optional()}).strict();
export const turnStopSchema=z.object({turn_id:turnId,stop_hook_active:z.boolean(),stats:turnStatsSchema,background:turnBackgroundSchema,deadline_at:at.optional()}).strict();
export const turnCompletedSchema=z.object({
  turn_id:turnId,
  completed_at:at,
  stats:turnStatsSchema,
  background:turnBackgroundSchema,
  interventions:z.array(z.object({id:z.string().min(1).max(128),inert:z.boolean()}).strict()).max(16),
}).strict();
export const humanPromptSchema=z.object({human_origin:z.enum(['composer','desktop','vscode']),human_turn_id:turnId,human_input_at:at}).strict();

const agyLsSchema=z.object({address:text,csrfToken:z.string().min(1).max(512)}).strict();

export const hookClientSchema=z.object({hook_pid:z.number().int().positive(),config_home:text,cwd:text,started_at:z.number().finite(),elapsed_ms:z.number().finite().nonnegative(),input:z.record(z.string(),z.unknown())}).strict();
export const mcpHookClientSchema=hookClientSchema.extend({thread_id:text});
export const agyHookClientSchema=hookClientSchema.extend({conversation_id:text.optional(),root_conversation_id:text.optional(),owned_launch:z.object({peerId:z.string().uuid(),launchId:z.string().uuid()}).optional(),agy_ls:agyLsSchema.optional()});
export const registerSchema=z.object({host,sessionId:text,cwd:text,cwdFallback:z.boolean().optional(),artifactsDirFallback:z.boolean().optional(),transcriptPathFallback:z.boolean().optional(),name:z.string().optional(),kind:z.enum(['root','subagent','fork','unknown']).optional(),parentId:z.string().optional(),permission:z.enum(['prompting','bypass','unknown']).optional(),state:z.enum(['ready','busy','needsHuman','offline','unknown','paused','starting']).optional(),replyContract:z.literal(1).optional(),contextStart:z.boolean().optional(),contextReason:z.enum(['reset','switch','fork','unknown']).optional(),endpoint:z.object({epoch:text,mode:z.enum(['app-server','embedded','agy-acp','agy-tui']),address:z.string(),pid:z.number().int().positive().nullable(),procStart:z.string().nullable(),nativePermission:nativePermissionSchema.optional(),nativeBackground:nativeBackgroundSchema.optional(),codexPermission:z.object({sandbox:z.string().optional(),approval:z.enum(['prompting','bypass','unknown']).optional(),autoReview:z.boolean().optional()}).optional(),questionSupport:z.boolean().optional(),configHome:text.optional(),launchProfileId:text.optional(),native:processSchema.optional(),bridge:processSchema.optional(),runtimeId:text.optional(),processKind:z.enum(['foreground','app-server']).optional(),nativeSession:nativeSessionSchema.optional(),daemon:z.object({address:z.string(),rootSessionId:text.optional(),forkedFromId:text.optional(),sandbox:z.string().optional(),approval:z.enum(['prompting','bypass','unknown']).optional(),autoReview:z.boolean().optional()}).optional()})});
export const mcpRegisterSchema=registerSchema.extend(profileSchema.shape).extend({expectedBinding:actorSchema.shape.binding,boundaryStartedAt:z.number().finite().optional(),context_key:text.optional(),agyLs:agyLsSchema.optional()});
