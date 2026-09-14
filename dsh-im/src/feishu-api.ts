/** Small Feishu REST client; callers provide fetch so it is deterministic in tests. */
export interface FeishuApi {
  authorize(
    code: string
  ): Promise<{
    tenantAccessToken: string
    botOpenId: string
    botName: string
    tenantName?: string
  }>
  sendText(
    token: string,
    receiveId: string,
    text: string,
    replyTo?: string
  ): Promise<void>
}
export function createFeishuApi (
  fetcher: typeof fetch = fetch,
  baseUrl = 'https://open.feishu.cn'
): FeishuApi {
  const request = async (
    path: string,
    init: RequestInit
  ): Promise<Record<string, unknown>> => {
    const response = await fetcher(`${baseUrl}${path}`, init)
    const body = (await response.json()) as Record<string, unknown>
    if (!response.ok || body.code !== 0)
      throw new Error(
        `feishu API failed: ${String(body.msg ?? response.status)}`
      )
    return body
  }
  return {
    async authorize (code) {
      const body = await request('/open-apis/authen/v1/oidc/access_token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', code })
      })
      const data = body.data as Record<string, unknown>
      return {
        tenantAccessToken: String(data.tenant_access_token),
        botOpenId: String(data.open_id),
        botName: String(data.name ?? data.open_id),
        tenantName:
          data.tenant_name === undefined ? undefined : String(data.tenant_name)
      }
    },
    async sendText (token, receiveId, text, replyTo) {
      await request(
        replyTo
          ? `/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply`
          : '/open-apis/im/v1/messages?receive_id_type=chat_id',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            receive_id: receiveId,
            msg_type: 'text',
            content: JSON.stringify({ text })
          })
        }
      )
    }
  }
}
