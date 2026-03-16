// Search tool — web search via Tavily or Serper

import type { ToolDefinition } from '../providers/provider.js'
import type { Source } from '../types.js'

export const searchToolDef: ToolDefinition = {
  name: 'web_search',
  description: 'Search the web for current information. Use when the question requires up-to-date facts, news, or data.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
}

interface SearchConfig {
  provider?: 'tavily' | 'serper'
  apiKey?: string
}

export async function executeSearch(
  input: Record<string, unknown>,
  config?: SearchConfig
): Promise<{ text: string; sources: Source[]; images?: string[] }> {
  const query = String(input.query ?? '')
  if (!query) return { text: 'No query provided', sources: [] }

  const provider = config?.provider ?? 'tavily'

  if (provider === 'tavily') {
    return searchTavily(query, config?.apiKey)
  }
  return searchSerper(query, config?.apiKey)
}

async function searchTavily(query: string, apiKey?: string): Promise<{ text: string; sources: Source[]; images?: string[] }> {
  if (!apiKey) throw new Error('Search requires apiKey — set toolConfig.search.apiKey')

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: 5, include_answer: true, include_images: true }),
  })

  if (!res.ok) throw new Error(`Tavily error ${res.status}: ${await res.text()}`)

  const data = await res.json() as { answer?: string; results?: { title: string; url: string; content: string }[]; images?: { url: string }[] }
  const sources = (data.results ?? []).map(r => ({ title: r.title, url: r.url, snippet: r.content }))
  const images = (data.images ?? []).map(img => typeof img === 'string' ? img : img.url)
  const text = data.answer ?? sources.map(s => `${s.title}: ${s.snippet}`).join('\n')

  return { text, sources, images }
}

async function searchSerper(query: string, apiKey?: string): Promise<{ text: string; sources: Source[] }> {
  if (!apiKey) throw new Error('Search requires apiKey — set toolConfig.search.apiKey')

  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: query, num: 5 }),
  })

  if (!res.ok) throw new Error(`Serper error ${res.status}: ${await res.text()}`)

  const data = await res.json() as { organic?: { title: string; link: string; snippet: string }[] }
  const sources = (data.organic ?? []).map(r => ({ title: r.title, url: r.link, snippet: r.snippet }))
  const text = sources.map(s => `${s.title}: ${s.snippet}`).join('\n')

  return { text, sources }
}
