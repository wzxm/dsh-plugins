/**
 * Conversation identity for inbound Feishu messages.
 *
 * `conversationKey` builds the stable string a Session is keyed on. The previous
 * version of this module produced that composite key and then the sender passed
 * it straight back to Feishu as `receive_id` — but a routing key is not a Feishu
 * address. Replying needs the *real* `chat_id` (or the sender's `open_id` for a
 * p2p chat), which {@link receiveTarget} now derives explicitly.
 *
 * @module dsh-im/conversation
 */

import type { NormalizedMessage } from './event.ts'

/**
 * Where a reply must be sent, in the form Feishu's send API expects.
 *
 * `receive_id_type` and `receive_id` travel together: sending a `chat_id` while
 * declaring `open_id` fails, so the pair is carried as one value.
 */
export interface ReplyTarget {
  /** Value for the `receive_id_type` query parameter. */
  readonly receiveIdType: 'chat_id' | 'open_id'
  /** Value for the body's `receive_id` field. */
  readonly receiveId: string
}

/**
 * Derive the reply destination for one message.
 *
 * A p2p chat is answered to the sender's `open_id`; a group chat is answered to
 * the `chat_id`. The `chat_id` is used even when a group message arrives in a
 * thread, because Feishu threads are addressed through `reply_message` rather
 * than a different receive id.
 * @param message - the normalized inbound message.
 * @returns the receive-id type and value to send with.
 * @throws {Error} when the fields needed for that chat type are missing.
 */
export function receiveTarget (message: NormalizedMessage): ReplyTarget {
  if (message.chatType === 'p2p') {
    if (message.senderOpenId === '') {
      throw new Error(
        'cannot reply to a p2p message without the sender open_id'
      )
    }
    return { receiveIdType: 'open_id', receiveId: message.senderOpenId }
  }
  return { receiveIdType: 'chat_id', receiveId: message.chatId }
}

/**
 * Build the stable identity for one conversation.
 *
 * Scoping by bot keeps two apps that share a chat from writing into the same
 * Session. The thread segment separates a threaded discussion from the chat's
 * main timeline, so a `@bot` in a thread does not append to the parent Session.
 * @param botId - the configured bot instance id.
 * @param message - the normalized inbound message.
 * @returns the conversation key.
 */
export function conversationKey (
  botId: string,
  message: Pick<
    NormalizedMessage,
    'chatType' | 'chatId' | 'threadId' | 'parentId'
  >
): string {
  return [
    botId,
    message.chatType,
    message.chatId,
    message.threadId ?? message.parentId ?? 'root'
  ].join(':')
}
