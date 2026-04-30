import { describe, it, expect } from 'vitest'

import {
  resolveProvider,
  translateToAnthropic,
  translateFromAnthropic,
  translateToGoogle,
  translateFromGoogle,
  translateRequestToProvider,
  translateResponseToOpenAI,
} from '../api/src/providers'
import { buildUpstreamRequest } from '../api/src/upstream'

describe('resolveProvider', () => {
  it.each([
    ['claude-sonnet-4-5', 'anthropic', 'claude-sonnet-4-5'],
    ['claude-3-5-haiku-latest', 'anthropic', 'claude-3-5-haiku-latest'],
    ['claude/claude-3-opus', 'anthropic', 'claude-3-opus'],
    ['gpt-4o', 'openai', 'gpt-4o'],
    ['gpt-4o-mini', 'openai', 'gpt-4o-mini'],
    ['o1-preview', 'openai', 'o1-preview'],
    ['o3-mini', 'openai', 'o3-mini'],
    ['o4-mini', 'openai', 'o4-mini'],
    ['gemini-2.0-flash', 'google', 'gemini-2.0-flash'],
    ['gemini-1.5-pro-latest', 'google', 'gemini-1.5-pro-latest'],
    ['anthropic/claude-3-opus-20240229', 'anthropic', 'claude-3-opus-20240229'],
    ['openai/gpt-4o', 'openai', 'gpt-4o'],
    ['google/gemini-2.0-flash', 'google', 'gemini-2.0-flash'],
  ])('routes %s → %s (%s)', (model, expectedProvider, expectedModel) => {
    const r = resolveProvider(model)
    expect(r.provider).toBe(expectedProvider)
    expect(r.model).toBe(expectedModel)
    expect(r.fallback).toBe(false)
  })

  it('falls back to openai for unknown prefixes', () => {
    const r = resolveProvider('mistral-large')
    expect(r.provider).toBe('openai')
    expect(r.fallback).toBe(true)
  })

  it('falls back to openai (gpt-4o) for empty model', () => {
    const r = resolveProvider('')
    expect(r.provider).toBe('openai')
    expect(r.model).toBe('gpt-4o')
    expect(r.fallback).toBe(true)
  })

  it('explicit prefix beats keyword match', () => {
    // Pathological case: someone writes "openai/claude-3-opus" — explicit prefix wins.
    const r = resolveProvider('openai/claude-3-opus')
    expect(r.provider).toBe('openai')
    expect(r.model).toBe('claude-3-opus')
  })
})

describe('Anthropic request translation', () => {
  it('extracts the system message into a top-level system field', () => {
    const out = translateToAnthropic({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'system', content: 'You are a helpful CFO assistant.' },
        { role: 'user', content: 'Hello' },
      ],
      max_tokens: 256,
    })
    expect(out.system).toBe('You are a helpful CFO assistant.')
    expect(out.messages).toEqual([{ role: 'user', content: 'Hello' }])
    expect(out.max_tokens).toBe(256)
    expect(out.model).toBe('claude-sonnet-4-5')
  })

  it('concatenates multiple system messages with double-newline', () => {
    const out = translateToAnthropic({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'system', content: 'Rule 1' },
        { role: 'system', content: 'Rule 2' },
        { role: 'user', content: 'Hi' },
      ],
    })
    expect(out.system).toBe('Rule 1\n\nRule 2')
  })

  it('defaults max_tokens to 1024 (Anthropic requires it)', () => {
    const out = translateToAnthropic({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'x' }],
    })
    expect(out.max_tokens).toBe(1024)
  })

  it('drops OpenAI-only fields and maps stop → stop_sequences', () => {
    const out = translateToAnthropic({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'x' }],
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      stop: ['END', 'STOP'],
      temperature: 0.5,
      top_p: 0.9,
    })
    expect(out.frequency_penalty).toBeUndefined()
    expect(out.presence_penalty).toBeUndefined()
    expect(out.stop_sequences).toEqual(['END', 'STOP'])
    expect(out.temperature).toBe(0.5)
    expect(out.top_p).toBe(0.9)
  })

  it('handles content as an array of parts', () => {
    const out = translateToAnthropic({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] },
      ],
    })
    expect(out.messages).toEqual([{ role: 'user', content: 'Hello world' }])
  })
})

describe('Anthropic response translation', () => {
  it('flattens content array → choices[0].message.content and maps usage', () => {
    const out = translateFromAnthropic(
      {
        id: 'msg_01ABC',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'Net income for March: $42,000.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 87, output_tokens: 14 },
      },
      'claude-sonnet-4-5',
    )
    expect((out.choices as any[])[0].message.content).toBe('Net income for March: $42,000.')
    expect((out.choices as any[])[0].finish_reason).toBe('stop')
    expect((out.usage as any).prompt_tokens).toBe(87)
    expect((out.usage as any).completion_tokens).toBe(14)
    expect((out.usage as any).total_tokens).toBe(101)
    expect(out.id).toBe('msg_01ABC')
    expect(out.model).toBe('claude-sonnet-4-5')
    expect(out.object).toBe('chat.completion')
  })

  it('maps max_tokens stop reason → length', () => {
    const out = translateFromAnthropic(
      { content: [{ type: 'text', text: 'truncated' }], stop_reason: 'max_tokens', usage: {} },
      'claude-sonnet-4-5',
    )
    expect((out.choices as any[])[0].finish_reason).toBe('length')
  })
})

describe('Google request translation', () => {
  it('maps system → systemInstruction and messages → contents with role mapping', () => {
    const out = translateToGoogle({
      model: 'gemini-2.0-flash',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'Tell me about runway.' },
      ],
      max_tokens: 128,
      temperature: 0.3,
    })
    expect((out.systemInstruction as any).parts[0].text).toBe('Be concise.')
    expect(out.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hi' }] },
      { role: 'model', parts: [{ text: 'Hello!' }] },
      { role: 'user', parts: [{ text: 'Tell me about runway.' }] },
    ])
    expect((out.generationConfig as any).maxOutputTokens).toBe(128)
    expect((out.generationConfig as any).temperature).toBe(0.3)
  })

  it('omits systemInstruction when no system message present', () => {
    const out = translateToGoogle({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'Hi' }],
    })
    expect(out.systemInstruction).toBeUndefined()
  })

  it('maps stop → generationConfig.stopSequences', () => {
    const out = translateToGoogle({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'x' }],
      stop: 'END',
    })
    expect((out.generationConfig as any).stopSequences).toEqual(['END'])
  })
})

describe('Google response translation', () => {
  it('extracts candidates[0].content.parts[0].text and maps usageMetadata', () => {
    const out = translateFromGoogle(
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Runway is approximately 14 months.' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 22, candidatesTokenCount: 9, totalTokenCount: 31 },
      },
      'gemini-2.0-flash',
    )
    expect((out.choices as any[])[0].message.content).toBe('Runway is approximately 14 months.')
    expect((out.choices as any[])[0].finish_reason).toBe('stop')
    expect((out.usage as any).prompt_tokens).toBe(22)
    expect((out.usage as any).completion_tokens).toBe(9)
    expect((out.usage as any).total_tokens).toBe(31)
    expect(out.model).toBe('gemini-2.0-flash')
  })

  it('maps SAFETY finish reason → content_filter', () => {
    const out = translateFromGoogle(
      {
        candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'SAFETY' }],
        usageMetadata: {},
      },
      'gemini-2.0-flash',
    )
    expect((out.choices as any[])[0].finish_reason).toBe('content_filter')
  })

  it('maps MAX_TOKENS finish reason → length', () => {
    const out = translateFromGoogle(
      {
        candidates: [{ content: { parts: [{ text: 'truncated...' }] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 5 },
      },
      'gemini-2.0-flash',
    )
    expect((out.choices as any[])[0].finish_reason).toBe('length')
  })
})

describe('Default fallback to OpenAI', () => {
  it('translateRequestToProvider passes through OpenAI bodies', () => {
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }
    const out = translateRequestToProvider('openai', body as any)
    expect(out).toEqual(body)
  })

  it('translateResponseToOpenAI passes through OpenAI responses', () => {
    const resp = { id: 'chatcmpl-x', choices: [{ message: { content: 'hi' } }], usage: {} }
    expect(translateResponseToOpenAI('openai', 'gpt-4o', resp as any)).toEqual(resp)
  })

  it('unknown model falls back to openai dispatch', () => {
    const r = resolveProvider('mistral-large-latest')
    expect(r.provider).toBe('openai')
    expect(r.fallback).toBe(true)
  })
})

describe('buildUpstreamRequest', () => {
  it('builds an Anthropic request with x-api-key + anthropic-version', () => {
    const out = buildUpstreamRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      openaiBody: {
        model: 'claude-sonnet-4-5',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
        max_tokens: 64,
      },
      providerKey: 'sk-ant-test',
    })
    expect(out.url.endsWith('/messages')).toBe(true)
    expect(out.headers['x-api-key']).toBe('sk-ant-test')
    expect(out.headers['anthropic-version']).toBe('2023-06-01')
    expect((out.body as any).system).toBe('sys')
    expect((out.body as any).model).toBe('claude-sonnet-4-5')
  })

  it('builds a Google request with x-goog-api-key and :generateContent path', () => {
    const out = buildUpstreamRequest({
      provider: 'google',
      model: 'gemini-2.0-flash',
      openaiBody: {
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
      providerKey: 'AIza-test',
    })
    expect(out.url.endsWith('/models/gemini-2.0-flash:generateContent')).toBe(true)
    expect(out.headers['x-goog-api-key']).toBe('AIza-test')
    expect((out.body as any).contents).toBeDefined()
  })

  it('builds an OpenAI request with Bearer auth and chat/completions path', () => {
    const out = buildUpstreamRequest({
      provider: 'openai',
      model: 'gpt-4o',
      openaiBody: {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      },
      providerKey: 'sk-test',
    })
    expect(out.url.endsWith('/chat/completions')).toBe(true)
    expect(out.headers['Authorization']).toBe('Bearer sk-test')
    expect((out.body as any).model).toBe('gpt-4o')
    expect((out.body as any).stream).toBe(false)
  })
})
