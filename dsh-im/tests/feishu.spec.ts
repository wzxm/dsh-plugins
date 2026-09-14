import { describe, it, expect } from 'vitest'
import {
  parseCallback,
  messageText,
  isBotMentioned,
  stripBotMentions,
  normalizeCallback,
  type FeishuCallback,
  type FeishuMention,
} from '../src/event.ts'
import { conversationKey, receiveTarget } from '../src/feishu.ts'
import { QuickOnboarding } from '../src/quick-onboarding.ts'

const BOT = 'ou_bot_open_id'

/**
 * A callback shaped like a real Feishu v2.0 `im.message.receive_v1` envelope.
 *
 * The details that matter and were previously modelled wrongly:
 * - `content` is a JSON **string**, so the text needs a second parse.
 * - `mentions[].id` is an **object** carrying `open_id`, not a bare string.
 * - group text contains the mention **placeholder** (`@_user_1`), not the name.
 */
function envelope(overrides: {
  chatType?: string
  text?: string
  mentions?: FeishuMention[]
  content?: string
  messageId?: string
  eventId?: string
  senderOpenId?: string
  includeMessage?: boolean
} = {}): FeishuCallback {
  const {
    chatType = 'p2p',
    text = 'hello',
    mentions,
    content,
    messageId = 'om_msg_1',
    eventId = 'evt_1',
    senderOpenId = 'ou_user_1',
    includeMessage = true,
  } = overrides
  return {
    schema: '2.0',
    header: { event_id: eventId, event_type: 'im.message.receive_v1' },
    event: includeMessage
      ? {
          sender: { sender_id: { open_id: senderOpenId }, sender_type: 'user' },
          message: {
            message_id: messageId,
            chat_id: 'oc_chat_1',
            chat_type: chatType,
            message_type: 'text',
            content: content ?? JSON.stringify({ text }),
            ...(mentions === undefined ? {} : { mentions }),
          },
        }
      : {},
  }
}

/** A serialized envelope, as it arrives over the wire. */
const wire = (c: FeishuCallback): string => JSON.stringify(c)

describe('parseCallback', () => {
  it('parses a v2.0 envelope', () => {
    const parsed = parseCallback(wire(envelope()))
    expect(parsed.schema).toBe('2.0')
    expect(parsed.header?.event_type).toBe('im.message.receive_v1')
  })

  it('parses the url_verification handshake', () => {
    const parsed = parseCallback(JSON.stringify({ type: 'url_verification', challenge: 'abc', token: 't' }))
    expect(parsed.challenge).toBe('abc')
    expect(parsed.type).toBe('url_verification')
  })

  it('rejects a non-object or malformed body', () => {
    for (const bad of ['', 'not json', '[1,2]', '"str"', 'null']) {
      expect(() => parseCallback(bad)).toThrow()
    }
  })
})

describe('messageText', () => {
  it('double-parses the JSON string content', () => {
    expect(messageText(JSON.stringify({ text: 'hi there' }))).toBe('hi there')
  })

  it('returns null for content it cannot read', () => {
    // A non-text message (image, file, …) carries a different content shape and
    // must be ignorable rather than fatal.
    for (const bad of [undefined, '', 'not json', JSON.stringify({ image_key: 'k' }), JSON.stringify(['a'])]) {
      expect(messageText(bad)).toBeNull()
    }
  })
})

describe('mentions', () => {
  // This is the exact shape the old `m.id === botOpenId` check could never match.
  const botMention = { key: '@_user_1', name: 'Bot', id: { open_id: BOT } }
  const otherMention = { key: '@_user_2', name: 'Someone', id: { open_id: 'ou_other' } }

  it('matches the bot through the nested id.open_id', () => {
    const message = { mentions: [botMention] }
    expect(isBotMentioned(message, BOT)).toBe(true)
    expect(isBotMentioned({ mentions: [otherMention] }, BOT)).toBe(false)
    expect(isBotMentioned({ mentions: [] }, BOT)).toBe(false)
    expect(isBotMentioned({}, BOT)).toBe(false)
  })

  it('strips the placeholder token, not the display name', () => {
    const text = '@_user_1 hello there'
    expect(stripBotMentions(text, [botMention], BOT)).toBe('hello there')
  })

  it('leaves other people’s mentions in place', () => {
    const text = '@_user_1 @_user_2 ping'
    expect(stripBotMentions(text, [botMention, otherMention], BOT)).toBe('@_user_2 ping')
  })

  it('removes every occurrence of the bot placeholder', () => {
    expect(stripBotMentions('@_user_1 a @_user_1 b', [botMention], BOT)).toBe('a  b')
  })
})

describe('normalizeCallback', () => {
  it('accepts a p2p message without any mention', () => {
    const result = normalizeCallback(envelope({ text: '  hi  ' }), BOT)
    expect(result).not.toBeNull()
    expect(result?.text).toBe('hi')
    expect(result?.chatType).toBe('p2p')
    expect(result?.chatId).toBe('oc_chat_1')
    expect(result?.eventId).toBe('evt_1')
  })

  it('accepts a group message that mentions the bot, with the placeholder removed', () => {
    const result = normalizeCallback(
      envelope({
        chatType: 'group',
        text: '@_user_1 run this',
        mentions: [{ key: '@_user_1', name: 'Bot', id: { open_id: BOT } }],
      }),
      BOT,
    )
    expect(result?.text).toBe('run this')
    expect(result?.chatType).toBe('group')
  })

  it('ignores a group message that does not mention the bot', () => {
    // The regression: with a nested id the old check failed here, so group
    // messages were dropped wholesale. Now the inverse must hold — a genuine
    // non-mention is ignored, a genuine mention is not.
    expect(normalizeCallback(envelope({ chatType: 'group', text: 'just chatting' }), BOT)).toBeNull()
    expect(
      normalizeCallback(
        envelope({ chatType: 'group', text: '@_user_2 hi', mentions: [{ key: '@_user_2', id: { open_id: 'ou_other' } }] }),
        BOT,
      ),
    ).toBeNull()
  })

  it('ignores non-actionable callbacks rather than throwing', () => {
    expect(normalizeCallback(envelope({ includeMessage: false }), BOT)).toBeNull()
    expect(normalizeCallback({ header: { event_id: 'e' }, event: {} }, BOT)).toBeNull()
    // Non-text message types.
    expect(normalizeCallback(envelope({ content: JSON.stringify({ image_key: 'k' }) }), BOT)).toBeNull()
    // Mention-only message leaves no prompt.
    expect(
      normalizeCallback(
        envelope({ chatType: 'group', text: '@_user_1', mentions: [{ key: '@_user_1', id: { open_id: BOT } }] }),
        BOT,
      ),
    ).toBeNull()
    // Missing chat id.
    expect(normalizeCallback({ header: { event_id: 'e' }, event: { message: { message_id: 'm', content: '{"text":"x"}' } } }, BOT)).toBeNull()
  })

  it('falls back to the message id when the header carries no event_id', () => {
    const c = envelope({ messageId: 'om_fallback' })
    const result = normalizeCallback({ ...c, header: {} }, BOT)
    expect(result?.eventId).toBe('om_fallback')
  })

  it('carries thread and parent identity through', () => {
    const base = envelope()
    const withThread: FeishuCallback = {
      ...base,
      event: {
        ...base.event,
        message: { ...base.event?.message, thread_id: 'omt_1', parent_id: 'om_parent' },
      },
    }
    const result = normalizeCallback(withThread, BOT)
    expect(result?.threadId).toBe('omt_1')
    expect(result?.parentId).toBe('om_parent')
  })
})

describe('receiveTarget', () => {
  it('answers a p2p chat through the sender open_id', () => {
    // The old code sent the composite conversation key as receive_id with a
    // hard-coded chat_id type; a p2p reply needs open_id.
    const target = receiveTarget({
      eventId: 'e', chatType: 'p2p', chatId: 'oc_chat_1',
      senderOpenId: 'ou_user_1', text: 'hi',
    })
    expect(target).toEqual({ receiveIdType: 'open_id', receiveId: 'ou_user_1' })
  })

  it('answers a group chat through the chat_id', () => {
    const target = receiveTarget({
      eventId: 'e', chatType: 'group', chatId: 'oc_chat_1',
      senderOpenId: 'ou_user_1', text: 'hi',
    })
    expect(target).toEqual({ receiveIdType: 'chat_id', receiveId: 'oc_chat_1' })
  })

  it('refuses a p2p reply with no sender to address', () => {
    expect(() =>
      receiveTarget({ eventId: 'e', chatType: 'p2p', chatId: 'oc_chat_1', senderOpenId: '', text: 'hi' }),
    ).toThrow()
  })
})

describe('conversationKey', () => {
  it('isolates by bot, chat type, chat, and thread', () => {
    expect(conversationKey('bot1', { chatType: 'p2p', chatId: 'c' })).toBe('bot1:p2p:c:root')
  })

  it('separates a thread from its parent chat timeline', () => {
    const main = conversationKey('bot1', { chatType: 'group', chatId: 'c' })
    const threaded = conversationKey('bot1', { chatType: 'group', chatId: 'c', threadId: 'omt_1' })
    expect(threaded).not.toBe(main)
    expect(threaded).toBe('bot1:group:c:omt_1')
  })

  it('uses the reply parent when there is no thread id', () => {
    expect(conversationKey('bot1', { chatType: 'group', chatId: 'c', parentId: 'om_p' })).toBe('bot1:group:c:om_p')
  })

  it('keeps two bots in one chat apart', () => {
    expect(conversationKey('botA', { chatType: 'group', chatId: 'c' }))
      .not.toBe(conversationKey('botB', { chatType: 'group', chatId: 'c' }))
  })
})

describe('quick onboarding', () => {
  it('uses one-time state', () => {
    const q = new QuickOnboarding(1000, () => 0)
    const s = q.create()
    expect(q.consume(s.id).status).toBe('authorizing')
    expect(() => q.consume(s.id)).toThrow()
  })
})
