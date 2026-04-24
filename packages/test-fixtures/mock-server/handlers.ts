import type { FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes } from 'crypto'

type ScenarioGetter = () => Record<string, any>

const randomHex = (bytes = 4) => randomBytes(bytes).toString('hex')
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function openaiChat(getScenario: ScenarioGetter) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const mode = getScenario().openai ?? 'success'
    const model = (req.body as any)?.model ?? 'gpt-4o-mini'

    if (mode === '500') {
      return reply.code(500).send({
        error: { message: 'simulated upstream error', type: 'server_error' },
      })
    }
    if (mode === 'rate_limit') {
      return reply
        .code(429)
        .header('retry-after', '30')
        .send({ error: { message: 'rate limited', type: 'rate_limit_error' } })
    }
    if (mode === 'timeout') {
      await delay(65_000)
    }

    const usage =
      mode === 'large_prompt'
        ? { prompt_tokens: 50000, completion_tokens: 500, total_tokens: 50500 }
        : { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 }

    return reply.code(200).send({
      id: `chatcmpl-mock-${randomHex(4)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'mocked response' },
          finish_reason: 'stop',
        },
      ],
      usage,
    })
  }
}

function anthropicMessages(getScenario: ScenarioGetter) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const mode = getScenario().anthropic ?? 'success'
    const model = (req.body as any)?.model ?? 'claude-haiku-3.5'

    if (mode === '500') {
      return reply.code(500).send({
        type: 'error',
        error: { type: 'api_error', message: 'simulated upstream error' },
      })
    }
    if (mode === 'rate_limit') {
      return reply
        .code(429)
        .header('retry-after', '30')
        .send({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'rate limited' },
        })
    }
    if (mode === 'overloaded') {
      return reply.code(529).send({
        type: 'error',
        error: { type: 'overloaded_error', message: 'overloaded' },
      })
    }

    return reply.code(200).send({
      id: `msg_mock_${randomHex(4)}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'mocked anthropic response' }],
      model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 30, output_tokens: 20 },
    })
  }
}

function stripeBalance(getScenario: ScenarioGetter) {
  return async (_req: FastifyRequest, reply: FastifyReply) => {
    const mode = getScenario().stripe ?? 'default'
    if (mode === '500') {
      return reply.code(500).send({
        error: { type: 'api_error', message: 'simulated upstream error' },
      })
    }
    const availableAmount = mode === 'empty' ? 0 : 2450000
    return reply.code(200).send({
      object: 'balance',
      available: [{ amount: availableAmount, currency: 'usd' }],
      pending: [{ amount: 180000, currency: 'usd' }],
    })
  }
}

function stripeInvoices(getScenario: ScenarioGetter) {
  return async (_req: FastifyRequest, reply: FastifyReply) => {
    const mode = getScenario().stripe ?? 'default'
    if (mode === '500') {
      return reply.code(500).send({
        error: { type: 'api_error', message: 'simulated upstream error' },
      })
    }

    const now = Math.floor(Date.now() / 1000)
    const month = 30 * 24 * 60 * 60
    const mkInvoice = (i: number, amountCents: number) => ({
      id: `in_mock_${randomHex(4)}`,
      object: 'invoice',
      customer: 'cus_mock_acme',
      amount_paid: amountCents,
      amount_due: amountCents,
      currency: 'usd',
      status: 'paid',
      period_start: now - (i + 1) * month,
      period_end: now - i * month,
      created: now - i * month,
    })

    return reply.code(200).send({
      object: 'list',
      url: '/v1/invoices',
      has_more: false,
      data: [mkInvoice(0, 89900), mkInvoice(1, 79900), mkInvoice(2, 69900)],
    })
  }
}

function vercelUsage(getScenario: ScenarioGetter) {
  return async (_req: FastifyRequest, reply: FastifyReply) => {
    const mode = getScenario().vercel ?? 'default'
    if (mode === '500') {
      return reply.code(500).send({ error: { message: 'simulated upstream error' } })
    }
    return reply.code(200).send({
      usage: {
        bandwidth: { amount: 52_000_000_000, unit: 'bytes' },
        serverless_function_invocations: { amount: 185_000 },
        edge_function_invocations: { amount: 42_000 },
      },
      billing_period: { start: '2026-03-01', end: '2026-03-31' },
      cost_cents: 4200,
    })
  }
}

function awsCostExplorer(getScenario: ScenarioGetter) {
  return async (_req: FastifyRequest, reply: FastifyReply) => {
    const mode = getScenario().aws ?? 'default'
    if (mode === '500') {
      return reply.code(500).send({
        __type: 'InternalServerException',
        message: 'simulated upstream error',
      })
    }
    return reply.code(200).send({
      ResultsByTime: [
        {
          TimePeriod: { Start: '2026-03-01', End: '2026-04-01' },
          Total: {
            UnblendedCost: { Amount: '2147.33', Unit: 'USD' },
          },
          Groups: [
            {
              Keys: ['Amazon Bedrock'],
              Metrics: { UnblendedCost: { Amount: '412.50', Unit: 'USD' } },
            },
            {
              Keys: ['Amazon Elastic Compute Cloud - Compute'],
              Metrics: { UnblendedCost: { Amount: '890.00', Unit: 'USD' } },
            },
            {
              Keys: ['Amazon Simple Storage Service'],
              Metrics: { UnblendedCost: { Amount: '124.83', Unit: 'USD' } },
            },
            {
              Keys: ['Amazon Relational Database Service'],
              Metrics: { UnblendedCost: { Amount: '720.00', Unit: 'USD' } },
            },
          ],
          Estimated: false,
        },
      ],
      DimensionValueAttributes: [],
    })
  }
}

export const handlers = {
  openaiChat,
  anthropicMessages,
  stripeBalance,
  stripeInvoices,
  vercelUsage,
  awsCostExplorer,
}
