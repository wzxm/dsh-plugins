export interface BotRecord {
  id: string
  name: string
  tenantName?: string
  botOpenId: string
  tokenRef: string
  workspacePath: string
  agentPreset: string
  enabled: boolean
}
export class BotStore {
  private readonly bots = new Map<string, BotRecord>()
  list (): BotRecord[] {
    return [...this.bots.values()].map(x => ({ ...x }))
  }
  add (record: BotRecord): BotRecord {
    if (this.bots.has(record.id))
      throw new Error(`bot already exists: ${record.id}`)
    this.bots.set(record.id, { ...record })
    return { ...record }
  }
  remove (id: string): void {
    this.bots.delete(id)
  }
}
