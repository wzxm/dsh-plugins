export type QuickState =
  | 'idle'
  | 'creating'
  | 'waiting_for_scan'
  | 'authorizing'
  | 'provisioning'
  | 'checking'
  | 'success'
  | 'failed'
  | 'expired'
export interface QuickSession {
  readonly id: string
  readonly state: string
  readonly expiresAt: number
  status: QuickState
  botId?: string
  error?: string
}
export class QuickOnboarding {
  private sessions = new Map<string, QuickSession>()
  constructor (
    private readonly ttlMs = 300000,
    private readonly now = () => Date.now()
  ) {}
  create (): QuickSession {
    const id = crypto.randomUUID()
    const s = {
      id,
      state: crypto.randomUUID(),
      expiresAt: this.now() + this.ttlMs,
      status: 'waiting_for_scan' as const
    }
    this.sessions.set(id, s)
    return { ...s }
  }
  get (id: string): QuickSession | undefined {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.status === 'waiting_for_scan' && this.now() >= s.expiresAt)
      s.status = 'expired'
    return { ...s }
  }
  transition (
    id: string,
    status: QuickState,
    botId?: string,
    error?: string
  ): QuickSession {
    const s = this.sessions.get(id)
    if (!s) throw new Error('quick onboarding session not found')
    if (s.status === 'expired' || s.status === 'success')
      throw new Error('quick onboarding session is closed')
    s.status = status
    s.botId = botId
    s.error = error
    return { ...s }
  }
  consume (id: string): QuickSession {
    const s = this.sessions.get(id)
    if (!s) throw new Error('quick onboarding session not found')
    if (s.status !== 'waiting_for_scan')
      throw new Error('quick onboarding session already used')
    s.status = 'authorizing'
    return { ...s }
  }
  cancel (id: string): void {
    this.sessions.delete(id)
  }
}
