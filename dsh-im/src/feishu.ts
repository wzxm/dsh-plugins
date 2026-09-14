export interface FeishuTextEvent {
  event_id: string
  chat_type: 'p2p' | 'group'
  chat_id: string
  sender_id: string
  text: string
  mentions?: Array<{ key: string; name: string; id: string }>
  thread_id?: string
  root_id?: string
}
export function normalizeMessage (
  event: FeishuTextEvent,
  botOpenId: string
): string | null {
  if (
    event.chat_type === 'group' &&
    !event.mentions?.some(m => m.id === botOpenId || m.key === `@${botOpenId}`)
  )
    return null
  let text = event.text
  for (const m of event.mentions ?? [])
    if (m.id === botOpenId || m.key === `@${botOpenId}`)
      text = text.replace(m.key, '')
  return text.trim() || null
}
export function conversationKey (
  botId: string,
  event: Pick<
    FeishuTextEvent,
    'chat_type' | 'chat_id' | 'thread_id' | 'root_id'
  >
): string {
  return [
    botId,
    event.chat_type,
    event.chat_id,
    event.thread_id ?? event.root_id ?? 'root'
  ].join(':')
}
