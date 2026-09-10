import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import '@deepseek-ai/dsh-user-approval'

export const name = 'dsh-mysql'
export const inject = ['tools', 'approval']

export interface Config {
  enabled?: boolean
  allowInsert?: boolean
  allowUpdate?: boolean
  allowDelete?: boolean
  allowAlter?: boolean
  allowTruncate?: boolean
  allowDrop?: boolean
  maxAffectedRows?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  allowInsert: z.boolean().default(false),
  allowUpdate: z.boolean().default(false),
  allowDelete: z.boolean().default(false),
  allowAlter: z.boolean().default(false),
  allowTruncate: z.boolean().default(false),
  allowDrop: z.boolean().default(false),
  maxAffectedRows: z.number().min(1).default(100),
})

const WRITE_TOOLS = new Map([
  ['insert', 'allowInsert'],
  ['update', 'allowUpdate'],
  ['delete', 'allowDelete'],
  ['alter', 'allowAlter'],
  ['truncate', 'allowTruncate'],
  ['drop', 'allowDrop'],
] as const)

function operation(name: string): keyof Config | undefined {
  if (!name.startsWith('mcp__mysql__')) return undefined
  const suffix = name.slice('mcp__mysql__'.length).toLowerCase()
  for (const [word, setting] of WRITE_TOOLS) if (suffix.includes(word)) return setting
  return undefined
}

function safeSummary(exec: ToolExecution): string {
  const args = JSON.stringify(exec.arguments)
  return `MySQL ${operation(exec.name)?.slice(5).toUpperCase() ?? 'WRITE'} request via ${exec.name}: ${args.slice(0, 4000)}`
}

export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const setting = operation(exec.name)
    if (setting === undefined) return next()
    if (config[setting] !== true) {
      return { kind: 'deny', reason: 'MYSQL_WRITE_AUTH_REQUIRED: this operation is disabled until explicitly enabled and approved.' }
    }
    const outcome: ApprovalOutcome = await ctx.approval.request({
      agent: exec.agent!,
      toolName: exec.name,
      callId: exec.callId,
      reason: safeSummary(exec),
      signal: exec.signal,
    })
    if (outcome !== 'allowed-once') {
      return { kind: 'deny', reason: `MYSQL_WRITE_AUTH_REQUIRED: approval outcome was ${outcome}.` }
    }
    return next()
  }, { prepend: true })
}

export default { name, inject, apply }
