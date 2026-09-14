/**
 * Feishu event values projected after signature verification.
 *
 * Declaring the `im` kind through module augmentation is what lets a
 * `WebhookRule<'im'>` receive a typed event instead of generic JSON, mirroring
 * how the GitHub adapter registers its own kind.
 *
 * @module dsh-im/webhook-types
 */

declare module '@deepseek-ai/dsh-webhook' {
  interface WebhookEventMap {
    im: FeishuWebhookEvent
  }
}

/** Provider event supplied to `WebhookRule<'im'>`. */
export interface FeishuWebhookEvent {
  /** Always `feishu`; distinguishes providers if another IM adapter shares the kind. */
  readonly provider: 'feishu'
  readonly chatType: 'p2p' | 'group'
  readonly chatId: string
  readonly senderOpenId: string
  /** Message text with the bot's own mention placeholders removed. */
  readonly text: string
  readonly threadId?: string
  readonly parentId?: string
}
