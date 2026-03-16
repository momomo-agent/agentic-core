// OpenAI-compatible provider — works with OpenAI, Groq, Together, any compatible API

import type { AgenticConfig } from '../types.js'
import type { Provider, ProviderMessage, ProviderResponse, ToolDefinition } from './provider.js'

export function createOpenAIProvider(config: AgenticConfig): Provider {
  const baseUrl = config.baseUrl ?? 'https://api.openai.com'
  const model = config.model ?? 'gpt-4o'

  return {
    async chat(messages: ProviderMessage[], tools: ToolDefinition[]): Promise<ProviderResponse> {
      const body: Record<string, unknown> = {
        model,
        stream: false,
        messages: convertMessages(messages),
      }

      if (tools.length > 0) {
        body.tools = tools.map(t => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      }

      const base = baseUrl.replace(/\/+$/, '')
      const endpoint = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const err = await res.text()
        throw new Error(`OpenAI API error ${res.status}: ${err}`)
      }

      // Handle SSE streaming responses (some proxies ignore stream:false and don't set proper content-type)
      const rawText = await res.text()
      let data: OpenAIResponse

      if (rawText.trimStart().startsWith('data: ')) {
        data = reassembleSSE(rawText)
      } else {
        data = JSON.parse(rawText) as OpenAIResponse
      }

      return parseResponse(data)
    }
  }
}

// --- SSE stream reassembly ---

function reassembleSSE(text: string): OpenAIResponse {
  const lines = text.split('\n')
  let content = ''
  const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map()
  let finishReason = 'stop'
  let usage = { prompt_tokens: 0, completion_tokens: 0 }

  for (const line of lines) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
    try {
      const chunk = JSON.parse(line.slice(6))
      const delta = chunk.choices?.[0]?.delta
      if (!delta) {
        if (chunk.usage) usage = chunk.usage
        continue
      }
      if (delta.content) content += delta.content
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          const existing = toolCalls.get(idx)
          if (!existing) {
            toolCalls.set(idx, { id: tc.id || '', name: tc.function?.name || '', args: tc.function?.arguments || '' })
          } else {
            if (tc.function?.arguments) existing.args += tc.function.arguments
          }
        }
      }
      // Handle Responses API format: tool calls in chunk.item (incremental)
      const item = chunk.item
      if (item?.call_id) {
        // Find existing entry by call_id or create new
        let found = false
        for (const [, tc] of toolCalls) {
          if (tc.id === item.call_id) {
            if (item.name) tc.name = item.name
            if (item.arguments) tc.args = item.arguments
            found = true
            break
          }
        }
        if (!found) {
          toolCalls.set(toolCalls.size, { id: item.call_id, name: item.name || '', args: item.arguments || '' })
        }
      }
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason
    } catch { /* skip malformed chunks */ }
  }

  const reassembledToolCalls = [...toolCalls.values()].map(tc => ({
    id: tc.id, function: { name: tc.name, arguments: tc.args },
  }))

  const hasToolCalls = reassembledToolCalls.length > 0

  return {
    choices: [{ message: { content: content || null, tool_calls: hasToolCalls ? reassembledToolCalls : undefined }, finish_reason: hasToolCalls ? 'tool_calls' : finishReason }],
    usage,
  }
}

// --- OpenAI response types ---

interface OpenAIToolCall {
  id: string
  function: { name: string; arguments: string }
}

interface OpenAIChoice {
  message: {
    content: string | null
    tool_calls?: OpenAIToolCall[]
  }
  finish_reason: string
}

interface OpenAIResponse {
  choices: OpenAIChoice[]
  usage: { prompt_tokens: number; completion_tokens: number }
}

function convertMessages(messages: ProviderMessage[]) {
  return messages.map(m => {
    if (m.role === 'tool' && Array.isArray(m.content)) {
      // Some proxies reject role:'tool', wrap as user message
      const parts = (m.content as { toolCallId: string; content: string }[])
        .map(c => `[Tool result for ${c.toolCallId}]: ${c.content}`)
        .join('\n')
      return { role: 'user' as const, content: parts }
    }
    return { role: m.role, content: m.content }
  }).flat()
}

function parseResponse(data: OpenAIResponse): ProviderResponse {
  const choice = data.choices?.[0]
  if (!choice) {
    return { text: '', toolCalls: [], usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 }, stopReason: 'end' }
  }
  const toolCalls = (choice.message?.tool_calls ?? []).map(tc => {
    let input: Record<string, unknown> = {}
    try { input = JSON.parse(tc.function.arguments || '{}') } catch { /* empty args */ }
    return { id: tc.id, name: tc.function.name, input, arguments: tc.function.arguments || '' }
  })

  return {
    text: choice?.message.content ?? '',
    toolCalls,
    usage: { input: data.usage.prompt_tokens, output: data.usage.completion_tokens },
    stopReason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end',
  }
}
