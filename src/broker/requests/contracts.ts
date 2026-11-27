import {z} from 'zod';

export const text=z.string().min(1).max(262144);
export const host=z.enum(['agy','codex']);
export const actorSchema=z.object({host,memberId:text.optional(),sessionId:text,callId:text,via:z.string().optional(),turnId:text.optional(),binding:z.object({key:text,epoch:text}).optional()});
export const targetSchema=z.object({actor:actorSchema.optional(),pair_id:text.optional(),peer_id:text.optional(),session_id:text.optional(),native:z.object({host,pid:z.number().int().positive(),procStart:text}).optional()});
export const restartSchema=targetSchema.extend({partner:z.literal(true).optional()});
export const profileSchema=z.object({model:z.string().min(1).nullable().optional(),effort:z.union([z.string().min(1),z.number().finite()]).nullable().optional()});
export const processSchema=z.object({pid:z.number().int().positive(),procStart:text});
export const nativeSessionSchema=z.object({
  transcriptPath:text.optional(),
  transcriptPathFallback:z.boolean().optional(),
  artifactsDir:text.optional(),
  interactive:z.boolean().optional(),
}).strict();

export const hookClientSchema=z.object({hook_pid:z.number().int().positive(),config_home:text,cwd:text,started_at:z.number().finite(),elapsed_ms:z.number().finite().nonnegative(),input:z.record(z.string(),z.unknown())}).strict();
export const mcpHookClientSchema=hookClientSchema.extend({thread_id:text});
export const agyHookClientSchema=hookClientSchema.extend({conversation_id:text.optional(),root_conversation_id:text.optional(),owned_launch:z.object({peerId:z.string().uuid(),launchId:z.string().uuid()}).optional()});
export const registerSchema=z.object({host,sessionId:text,cwd:text,cwdFallback:z.boolean().optional(),artifactsDirFallback:z.boolean().optional(),transcriptPathFallback:z.boolean().optional(),name:z.string().optional(),kind:z.enum(['root','subagent','fork','unknown']).optional(),parentId:z.string().optional(),permission:z.enum(['prompting','bypass','unknown']).optional(),state:z.enum(['ready','busy','needsHuman','offline','unknown','paused','starting']).optional(),replyContract:z.literal(1).optional(),contextStart:z.boolean().optional(),contextReason:z.enum(['reset','switch','fork','unknown']).optional(),endpoint:z.object({epoch:text,mode:z.enum(['app-server','embedded','agy-acp','agy-tui']),address:z.string(),pid:z.number().int().positive().nullable(),procStart:z.string().nullable(),codexPermission:z.object({sandbox:z.string().optional(),approval:z.enum(['prompting','bypass','unknown']).optional(),autoReview:z.boolean().optional()}).optional(),questionSupport:z.boolean().optional(),configHome:text.optional(),launchProfileId:text.optional(),native:processSchema.optional(),bridge:processSchema.optional(),runtimeId:text.optional(),processKind:z.enum(['foreground','app-server']).optional(),nativeSession:nativeSessionSchema.optional(),daemon:z.object({address:z.string(),rootSessionId:text.optional(),forkedFromId:text.optional(),sandbox:z.string().optional(),approval:z.enum(['prompting','bypass','unknown']).optional(),autoReview:z.boolean().optional()}).optional()})});
export const mcpRegisterSchema=registerSchema.extend(profileSchema.shape).extend({expectedBinding:actorSchema.shape.binding,boundaryStartedAt:z.number().finite().optional(),context_key:text.optional()});
