// Anthropic provider — Claude API with tool use

import type { AgenticConfig } from '../types.js'
import type { Provider, ProviderMessage, ProviderResponse, ToolDefinition } from './provider.js'

export function createAnthropicProvider(config: AgenticConfig): Provider {
  const base = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')
  const endpoint = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
  const model = config.model ?? 'claude-sonnet-4-20250514'

  return {
    async chat(messages: ProviderMessage[], tools: ToolDefinition[]): Promise<ProviderResponse> {
      const body: Record<string, unknown> = {
        model,
        max_tokens: 4096,
        messages: convertMessages(messages),
      }

      if (tools.length > 0) {
        body.tools = tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }))
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const err = await res.text()
        throw new Error(`Anthropic API error ${res.status}: ${err}`)
      }

      const data = await res.json() as AnthropicResponse
      return parseResponse(data)
    }
  }
}

// --- Anthropic response types ---

interface AnthropicContentBlock {
  type: 'text' | 'tool_use'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

interface AnthropicResponse {
  content: AnthropicContentBlock[]
  stop_reason: string
  usage: { input_tokens: number; output_tokens: number }
}

function convertMessages(messages: ProviderMessage[]) {
  return messages.map(m => {
    if (m.role === 'tool' && Array.isArray(m.content)) {
      return {
        role: 'user',
        content: m.content.map(c => ({
          type: 'tool_result',
          tool_use_id: (c as { toolCallId: string }).toolCallId,
          content: (c as { content: string }).content,
        })),
      }
    }
    return { role: m.role, content: m.content }
  })
}

function parseResponse(data: AnthropicResponse): ProviderResponse {
  let text = ''
  const toolCalls: ProviderResponse['toolCalls'] = []

  for (const block of data.content) {
    if (block.type === 'text' && block.text) {
      text += block.text
    } else if (block.type === 'tool_use' && block.id && block.name) {
      toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} })
    }
  }

  return {
    text,
    toolCalls,
    usage: { input: data.usage.input_tokens, output: data.usage.output_tokens },
    stopReason: data.stop_reason === 'tool_use' ? 'tool_use' : 'end',
    rawContent: data.content,
  }
}
