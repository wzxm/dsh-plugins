/**
 * Verifies the SHIPPED lib/index.js (not src/) boots in real Cordis and serves
 * the reply loop. This is the artifact the profile will load after a restart, so
 * a green result here is the strongest pre-restart evidence available.
 */
import { describe, it, expect, vi } from 'vitest'
import { createHash, randomBytes, createCipheriv } from 'node:crypto'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import plugin, { Config } from '../lib/index.js'

const KEY = 'live-key'
const sign = (raw:string,t:string,n:string,k:string) => createHash('sha256').update(t+n+k+raw).digest('hex')
const enc = (p:string,k:string) => { const key=createHash('sha256').update(k).digest(); const iv=randomBytes(16); const c=createCipheriv('aes-256-cbc',key,iv); return Buffer.concat([iv,c.update(p,'utf8'),c.final()]).toString('base64') }

describe('shipped lib/ in real Cordis', () => {
  it('registers routes, verifies signature, and replies', async () => {
    const routes = new Map<string, any>()
    const sent: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input)
      if (url.includes('access_token')) return new Response(JSON.stringify({ code:0, tenant_access_token:'t', app_access_token:'a', expire:7200 }), { status:200, headers:{'content-type':'application/json'} })
      if (url.includes('/im/v1/messages')) {
        sent.push(JSON.parse(JSON.parse(String(init?.body ?? '{}')).content ?? '{}').text ?? '')
        return new Response(JSON.stringify({ code:0, data:{} }), { status:200, headers:{'content-type':'application/json'} })
      }
      throw new Error('unexpected fetch: ' + url)
    }) as any

    const log: Array<Record<string, unknown>> = []
    const agent = {
      session: { get seq(){ return log.length }, eventAt:(s:number)=>log[s] },
      followup: () => {
        log.push({ type:'turn/start', data:{turn:1} })
        log.push({ type:'assistant/message', data:{turn:1,step:1,message:{content:[{type:'text',text:'lib build replies'}]}} })
        log.push({ type:'turn/end', data:{turn:1,reason:{kind:'completed'}} })
      },
      whenIdle: async () => {},
    }

    const ctx = new Context()
    await ctx.plugin({ name:'stubs', apply(sc: Context){
      sc.provide('webServer', { register:(r:any)=>{ routes.set(r.path,r.handler); return ()=>{} } })
      sc.provide('credentials', { resolve: async()=>({ value:KEY, source:'stub' }) })
      const services: Record<string, unknown> = {
        agents:{ create: async()=>({ agent, dispose: async()=>{} }) },
        agentPresets:{ resolve: async()=>({id:'standard'}), mount: async()=>{}, standingKeyFor: async()=>'k' },
        agentDefaultModel:{ currentSelection: ()=>({provider:'p',model:'m'}) },
        permissionPresets:{ resolve: ()=>'d', set: ()=>{} },
        sessionTitle:{ rename: ()=>{} },
        workspaceRegistry:{ create: async(p:string)=>({path:p,attachSession:async()=>{}}) },
      }
      for (const [k, v] of Object.entries(services)) sc.provide(k, v as never)
    }})

    const validated = Config['~standard'].validate({
      encryptKeyRef: 'C', appIdRef: 'A', appSecretRef: 'S',
      botOpenId: 'ou_bot', workspacePath: '/tmp/ws',
    })
    if (validated instanceof Promise || validated.issues !== undefined) {
      throw new Error(`invalid test config: ${JSON.stringify(validated)}`)
    }
    await ctx.plugin(plugin as never, validated.value as never)
    await new Promise(r=>setTimeout(r,30))

    expect([...routes.keys()].sort()).toEqual(['/oauth/feishu/callback','/webhooks/feishu'])

    const inner = JSON.stringify({ schema:'2.0', header:{event_id:'e',event_type:'im.message.receive_v1'}, event:{ sender:{sender_id:{open_id:'ou_u'}}, message:{message_id:'m',chat_id:'c',chat_type:'p2p',message_type:'text',content:JSON.stringify({text:'hi'})} } })
    const body = JSON.stringify({ encrypt: enc(inner, KEY) })
    const t='1', n='nn'
    const req = Readable.from([Buffer.from(body,'utf8')]) as any
    req.method='POST'
    req.headers={'content-type':'application/json','x-lark-request-timestamp':t,'x-lark-request-nonce':n,'x-lark-signature':sign(body,t,n,KEY)}
    req.headersDistinct={'content-type':['application/json'],'x-lark-request-timestamp':[t],'x-lark-request-nonce':[n],'x-lark-signature':[sign(body,t,n,KEY)]}
    Object.defineProperty(req,'complete',{value:true})
    const st:any={status:0,body:'',setHeader:()=>{},writeHead(s:number){st.status=s;return st},end(c?:string){st.body=c??''}}
    await routes.get('/webhooks/feishu')(req, st)
    await new Promise(r=>setTimeout(r,30))

    console.log('LIB BUILD -> status', st.status, 'sent', JSON.stringify(sent))
    expect(st.status).toBe(200)
    expect(sent).toEqual(['lib build replies'])
    globalThis.fetch = realFetch
    await ctx.fiber.dispose()
  })
})
