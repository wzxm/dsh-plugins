/**
 * Conversation → Session binding and assistant-output extraction.
 *
 * ## Why this module exists instead of the webhook runtime
 *
 * `webhookRuntime` is **fire-and-forget**: a rule returns a Session request, the
 * runtime creates the Session, and nothing ever reports what the agent said. An
 * IM adapter has to send the answer back, so it needs two things the runtime
 * does not provide:
 *
 * 1. a **stable binding** from a conversation (bot + chat + thread) to one live
 *    Agent, so a follow-up message continues the same Session; and
 * 2. a **read of the assistant's reply** once the turn settles.
 *
 * The reply is read from the durable session log rather than accumulated from a
 * live stream. The log is the source of truth, it is complete once
 * `whenIdle()` resolves, and reading it cannot miss content that a stream
 * listener attached too late would have dropped.
 *
 * @module dsh-im/session-bridge
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'

/** The assistant text and outcome of one turn. */
export interface TurnOutput {
  /** Concatenated text of the last assistant message in the turn, or `''`. */
  readonly text: string
  /** The `kind` of the turn's end reason, when a `turn/end` was observed. */
  readonly reason: string | undefined
  /** Whether the turn was interrupted before producing visible content. */
  readonly interrupted: boolean
}

/**
 * Extract the assistant's reply for the turn that started at `fromSeq`.
 *
 * Only events at or after `fromSeq` are considered, so a continuing
 * conversation returns this turn's answer rather than the previous one. The
 * **last** `assistant/message` wins: a turn may contain several steps, and the
 * final one carries the user-facing reply.
 *
 * @param session - the live session whose log is read.
 * @param fromSeq - log offset captured before the prompt was submitted.
 * @returns the turn's text, end reason, and interruption flag.
 */
export function readTurnOutput (
  session: Session,
  fromSeq: number
): TurnOutput {
  let text = ''
  let reason: string | undefined
  let interrupted = false
  let started = false
  const length = session.seq
  for (let seq = fromSeq; seq < length; seq += 1) {
    const event: SessionEvent | undefined = session.eventAt(SessionSeq(seq))
    // A hole below the captured length would mean the log changed under us;
    // skipping is safer than throwing inside a reply path.
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    // Ignore anything before this turn opened (e.g. a trailing event from the
    // previous turn that landed after fromSeq was captured).
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
      if (event.data.interrupted === true) interrupted = true
    }
    if (event.type === 'turn/end') reason = event.data.reason.kind
  }
  return { text, reason, interrupted }
}

/** One live binding between a conversation key and its Agent. */
export interface ConversationBinding {
  /** Session identity, for diagnostics and titles. */
  readonly sessionId: string
  /** Submit one prompt and resolve with the turn's reply. */
  ask(prompt: string): Promise<TurnOutput>
}

/**
 * Serializes prompts per conversation.
 *
 * Two messages arriving close together must not interleave into one Agent: the
 * second would be consumed as steering for the first turn, and its reply would
 * be read as part of the same turn. A per-key promise chain makes each prompt
 * wait for the previous one to settle.
 */
export class ConversationQueue {
  private readonly tails = new Map<string, Promise<unknown>>()

  /**
   * Run `task` after every previously queued task for `key` has settled.
   * @param key - the conversation key.
   * @param task - the work to serialize.
   * @returns the task's result.
   */
  run<T> (key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    // `then(task, task)` runs the task after a predecessor that rejected too, so
    // one failed prompt cannot stall its conversation forever.
    const next = previous.then(task, task)
    // The stored tail swallows rejection: it exists only to order successors,
    // and the caller receives the real outcome through `next`.
    const tail = next.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    void tail.then(() => {
      // Only the current tail may prune the entry, so a successor enqueued while
      // this task ran is not dropped from the map.
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return next
  }

  /** Number of tracked conversations; for tests and diagnostics. */
  get size (): number {
    return this.tails.size
  }
}
