/**
 * Inbound message → Agent turn → Feishu reply.
 *
 * This module owns the whole round trip and deliberately does **not** go through
 * `webhookRuntime`, for the reason recorded in `session-bridge.ts`: that runtime
 * creates a Session and never reports what the agent said, so it cannot drive a
 * reply back to the chat.
 *
 * It follows the same creation sequence as `@deepseek-ai/dsh-webhook`'s
 * `createWebhookSession` — resolve presets, create the workspace, create the
 * Agent with a `setup` that mounts the preset, attach, set permission, title —
 * because that sequence is the one proven to leave a Session able to accept a
 * prompt.
 *
 * ## Two contexts, and why the difference matters
 *
 * - A **plugin-scoped** context owns every Agent created here. A conversation
 *   outlives any single request, so Agents cannot be tied to a request scope.
 * - `ctx.inject([...])` supplies the **Agent stack** once those services exist.
 *   Route registration must not wait for them — the callback route has to answer
 *   even in a profile with no Agent loop — so registration stays in `apply` and
 *   only the wiring is gated.
 *
 * @module dsh-im/dispatch
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import { brandString } from '@deepseek-ai/dsh-brand'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { NormalizedMessage } from './event.ts'
import { conversationKey, receiveTarget } from './feishu.ts'
import type { FeishuApi } from './feishu-api.ts'
import { ConversationQueue, readTurnOutput, type TurnOutput } from './session-bridge.ts'

/** Resolved configuration for one dispatch executor. */
export interface DispatcherConfig {
  /** Bot instance id; scopes conversation keys so two bots never share a Session. */
  readonly botId: string
  /** Working directory for Sessions created by this bot. */
  readonly workspacePath: string
  /** Agent composition mounted for each new Session. */
  readonly agentPreset: string
  /** Permission preset applied to each Session. */
  readonly permissionPreset: string
  /** Ceiling on one reply, in characters, before truncation. */
  readonly maxReplyChars: number
}

/** The outcome of handling one message. */
export interface DispatchResult {
  readonly replied: boolean
  /** Why no reply was sent, when `replied` is false. */
  readonly reason?: string
}

/**
 * Truncate a reply so an overlong answer cannot be rejected by the Feishu API.
 * @param text - the assistant text.
 * @param max - character ceiling.
 * @returns the text, ellipsized when it exceeded the ceiling.
 */
function truncate (text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Build the dispatcher that turns messages into turns and replies.
 * @param ctx - plugin-scoped context that owns created Agents.
 * @param config - resolved dispatch configuration.
 * @param api - Feishu client used to send the reply.
 * @returns a function handling one normalized message.
 */
export function createDispatcher (
  ctx: Context,
  config: DispatcherConfig,
  api: FeishuApi
): (message: NormalizedMessage) => Promise<DispatchResult> {
  const queue = new ConversationQueue()
  /** Live Agents by conversation key. The binding is the Session continuity. */
  const agents = new Map<string, Agent>()

  /**
   * Create one Agent for a conversation.
   *
   * A deterministic session id derived from the conversation key means a restart
   * with persistence enabled resumes the same Session instead of forking a new
   * one per process.
   * @param key - conversation key.
   * @param title - initial Session title.
   * @returns the live Agent.
   */
  const openAgent = async (key: string, title: string): Promise<Agent> => {
    // Both are validated here so a misconfigured profile fails loudly at the
    // first message rather than leaving a half-configured Session.
    ctx.permissionPresets.resolve(config.permissionPreset)
    const preset = await ctx.agentPresets.resolve(config.agentPreset)
    await ctx.agentPresets.standingKeyFor(preset.id)

    const workspace = await ctx.workspaceRegistry.create(config.workspacePath)
    const selected = ctx.agentDefaultModel.currentSelection()
    // Feishu ids are opaque and may contain characters that are awkward in a log
    // path, so the id is derived deterministically but sanitized.
    const sessionId = brandString<SessionId>(
      `im-${config.botId}-${key}`.replace(/[^A-Za-z0-9._-]/g, '_'),
    )

    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path, agentPreset: preset.id },
      agentOptions: { provider: selected.provider, model: selected.model },
      setup: async (agentCtx: Context) => {
        await ctx.agentPresets.mount(agentCtx, preset.id)
      },
    })

    await workspace.attachSession(sessionId)
    ctx.permissionPresets.set(handle.agent.session, config.permissionPreset)
    ctx.sessionTitle.rename(handle.agent.session, title)
    agents.set(key, handle.agent)
    return handle.agent
  }

  /**
   * Ask one Agent for a reply.
   *
   * The log offset is captured **before** `followup`, so the reply is read from
   * exactly this turn rather than the previous exchange. `whenIdle()` is the
   * settlement signal: it resolves once no driver or maintenance task remains,
   * which is the point at which the log is complete.
   * @param agent - the live Agent.
   * @param prompt - the user's text.
   * @returns this turn's output.
   */
  const ask = async (agent: Agent, prompt: string): Promise<TurnOutput> => {
    const fromSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-im',
        form: 'notice',
        summary: boundContextSummary(`Feishu message via ${config.botId}`),
      },
    }))
    await agent.whenIdle()
    return readTurnOutput(agent.session, fromSeq)
  }

  return async (message: NormalizedMessage): Promise<DispatchResult> => {
    const key = conversationKey(config.botId, message)
    // Serialized per conversation: two prompts racing into one Agent would make
    // the second arrive as steering and merge both replies into one turn.
    return queue.run(key, async () => {
      let agent = agents.get(key)
      if (agent === undefined) {
        agent = await openAgent(key, `Feishu ${message.chatType} ${message.chatId}`)
      }

      const output = await ask(agent, message.text)
      if (output.text.trim() === '') {
        // A turn can settle with no assistant text (cancelled, or tool-only).
        // Sending an empty message would render as a blank bubble.
        return { replied: false, reason: output.reason ?? 'no assistant text' }
      }

      const token = await api.tenantToken()
      await api.sendText(
        token,
        receiveTarget(message),
        truncate(output.text, config.maxReplyChars),
      )
      return { replied: true }
    })
  }
}
