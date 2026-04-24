import Fastify from 'fastify'
import { handlers } from './handlers'

const PORT = Number(process.env.MOCK_SERVER_PORT ?? 4010)

const app = Fastify({ logger: false })

let scenario: Record<string, any> = { default: 'success' }

app.post('/_mock/scenario', async (req) => {
  scenario = (req.body as any) ?? {}
  return { ok: true, scenario }
})
app.get('/_mock/scenario', async () => ({ scenario }))
app.post('/_mock/reset', async () => { scenario = { default: 'success' }; return { ok: true } })

app.post('/v1/chat/completions', handlers.openaiChat(() => scenario))
app.post('/v1/messages', handlers.anthropicMessages(() => scenario))
app.get('/v1/balance', handlers.stripeBalance(() => scenario))
app.get('/v1/invoices', handlers.stripeInvoices(() => scenario))
app.get('/v1/usage', handlers.vercelUsage(() => scenario))
app.get('/v1/ce/cost', handlers.awsCostExplorer(() => scenario))

app.get('/_health', async () => ({ ok: true, port: PORT }))

app.listen({ port: PORT, host: '0.0.0.0' }, (err, addr) => {
  if (err) { console.error(err); process.exit(1) }
  console.log(`mock-server listening on ${addr}`)
})
