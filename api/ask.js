// Vercel Edge Runtime — /api/ask
// Streaming with no 10s timeout limit

export const config = { runtime: 'edge' }

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' },
    })
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const body = await req.json()
  const { prompt, tools = ['search', 'code'], provider = 'anthropic', baseUrl, apiKey, model, searchApiKey, messages: history, proxyUrl } = body
  if (!prompt) return new Response(JSON.stringify({ error: 'prompt required' }), { status: 400 })
  if (!apiKey) return new Response(JSON.stringify({ error: 'apiKey required' }), { status: 400 })

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      const emit = (event, data) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      try {
        emit('status', { message: 'Starting...' })
        const result = await agenticAsk(prompt, { provider, baseUrl, apiKey, model, tools, searchApiKey, history, proxyUrl }, emit)
        emit('done', result)
      } catch (err) {
        emit('error', { message: String(err) })
      }
      controller.close()
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' },
  })
}

// ── Agent loop ──

const MAX_ROUNDS = 10

async function agenticAsk(prompt, config, emit) {
  const chat = config.provider === 'anthropic' ? anthropicChat : openaiChat
  const toolDefs = buildToolDefs(config.tools)
  // Build messages from history + current prompt
  const messages = []
  if (config.history?.length) {
    for (const h of config.history) {
      messages.push({ role: 'user', content: h.prompt })
      messages.push({ role: 'assistant', content: h.answer })
    }
  }
  messages.push({ role: 'user', content: prompt })
  const acc = { sources: [], codeResults: [], files: [], toolCalls: [], images: [] }
  let usage = { input: 0, output: 0 }

  for (let i = 0; i < MAX_ROUNDS; i++) {
    emit('status', { message: `Round ${i + 1}: calling LLM...` })
    const res = await chat(messages, toolDefs, config)
    usage.input += res.usage.input; usage.output += res.usage.output

    if (res.stopReason !== 'tool_use' || !res.toolCalls.length) {
      return { answer: res.text, sources: acc.sources.length ? acc.sources : undefined, images: acc.images.length ? acc.images : undefined, codeResults: acc.codeResults.length ? acc.codeResults : undefined, toolCalls: acc.toolCalls.length ? acc.toolCalls : undefined, usage }
    }

    const results = []
    for (const tc of res.toolCalls) {
      emit('status', { message: `Executing ${tc.name}...` })
      const output = await execTool(tc, config, acc)
      acc.toolCalls.push({ tool: tc.name, input: tc.input, output })
      results.push(String(output))
      emit('tool', { name: tc.name, output: String(output).slice(0, 200) })
    }

    if (config.provider === 'anthropic') {
      messages.push({ role: 'assistant', content: res.rawContent || res.text })
      messages.push({ role: 'user', content: res.toolCalls.map((tc, idx) => ({ type: 'tool_result', tool_use_id: tc.id, content: results[idx] })) })
      continue
    }

    const summary = res.toolCalls.map(tc => `[tool: ${tc.name}]`).join(', ')
    messages.push({ role: 'assistant', content: [res.text, summary].filter(Boolean).join('\n') })
    messages.push({ role: 'user', content: `Tool results:\n${results.join('\n')}\n\nBased on the tool results above, provide the final answer directly. Do NOT mention or repeat the tool calls, do NOT say "I called..." or show function signatures. Just answer the question.` })

    emit('status', { message: 'Generating answer...' })
    const streamResult = await openaiChatStream(messages, [], config, emit)
    if (streamResult.usage) { usage.input += streamResult.usage.input; usage.output += streamResult.usage.output }
    return { answer: streamResult.text, sources: acc.sources.length ? acc.sources : undefined, images: acc.images.length ? acc.images : undefined, codeResults: acc.codeResults.length ? acc.codeResults : undefined, toolCalls: acc.toolCalls.length ? acc.toolCalls : undefined, usage }
  }
  throw new Error('Max tool rounds exceeded')
}

// ── Anthropic provider ──

async function anthropicChat(messages, tools, config) {
  const base = (config.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')
  const endpoint = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
  const body = {
    model: config.model || 'claude-sonnet-4-20250514', max_tokens: 4096,
    messages: messages.map(m => {
      if (m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result') return { role: 'user', content: m.content }
      return { role: m.role, content: m.content }
    }),
  }
  if (tools.length) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }))

  const res = await callLLM(endpoint, 
    { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
    body,
    config.proxyUrl
  )
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
  const data = await res.json()
  let text = ''; const toolCalls = []
  for (const b of data.content) {
    if (b.type === 'text') text += b.text
    else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, input: b.input || {} })
  }
  return { text, toolCalls, rawContent: data.content, usage: { input: data.usage.input_tokens, output: data.usage.output_tokens }, stopReason: data.stop_reason === 'tool_use' ? 'tool_use' : 'end' }
}

// ── OpenAI provider (non-streaming, for tool rounds) ──

async function openaiChat(messages, tools, config) {
  const base = (config.baseUrl || 'https://api.openai.com').replace(/\/+$/, '')
  const endpoint = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
  const body = { model: config.model || 'gpt-4o', stream: false, messages: messages.map(m => {
    if (m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result')
      return m.content.map(c => ({ role: 'tool', tool_call_id: c.tool_use_id, content: c.content }))
    return { role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }
  }).flat() }
  if (tools.length) body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))

  const res = await callLLM(endpoint,
    { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    body,
    config.proxyUrl
  )
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
  const rawText = await res.text()
  const data = rawText.trimStart().startsWith('data: ') ? reassembleSSE(rawText) : JSON.parse(rawText)
  const choice = data.choices[0]
  const toolCalls = (choice?.message.tool_calls || []).map(tc => {
    let input = {}; try { input = JSON.parse(tc.function.arguments || '{}') } catch {}
    return { id: tc.id, name: tc.function.name, input }
  })
  return { text: choice?.message.content || '', toolCalls, usage: { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 }, stopReason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end' }
}

// ── OpenAI streaming (final answer) ──

async function openaiChatStream(messages, tools, config, emit) {
  const base = (config.baseUrl || 'https://api.openai.com').replace(/\/+$/, '')
  const endpoint = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
  const body = {
    model: config.model || 'gpt-4o', stream: true,
    messages: messages.map(m => {
      if (m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result')
        return m.content.map(c => ({ role: 'tool', tool_call_id: c.tool_use_id, content: c.content }))
      return { role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }
    }).flat(),
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = '', fullText = '', streamUsage = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
      try {
        const chunk = JSON.parse(line.slice(6))
        const delta = chunk.choices?.[0]?.delta
        if (delta?.content) { fullText += delta.content; emit('token', { text: delta.content }) }
        if (chunk.usage) streamUsage = chunk.usage
      } catch {}
    }
  }
  return { text: fullText, usage: streamUsage ? { input: streamUsage.prompt_tokens || 0, output: streamUsage.completion_tokens || 0 } : null }
}

// ── Tool definitions ──

function buildToolDefs(tools) {
  const defs = []
  if (tools.includes('search')) defs.push({
    name: 'web_search', description: 'Search the web for current information.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] },
  })
  if (tools.includes('code')) defs.push({
    name: 'code_exec', description: 'Execute JavaScript code. Returns the result.',
    parameters: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript code' } }, required: ['code'] },
  })
  return defs
}

// ── Tool execution ──

async function execTool(tc, config, acc) {
  if (tc.name === 'web_search') return execSearch(tc.input, config, acc)
  if (tc.name === 'code_exec') return execCode(tc.input, acc)
  return `Unknown tool: ${tc.name}`
}

async function execSearch(input, config, acc) {
  const query = String(input.query || '')
  if (!config.searchApiKey) return 'Search requires searchApiKey'
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: config.searchApiKey, query, max_results: 5, include_answer: true, include_images: true }),
  })
  if (!res.ok) return `Search error: ${res.status}`
  const data = await res.json()
  const sources = (data.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content }))
  const images = (data.images || []).map(img => typeof img === 'string' ? img : img.url)
  acc.sources.push(...sources)
  if (images.length) acc.images.push(...images)
  return data.answer || sources.map(s => `${s.title}: ${s.snippet}`).join('\n')
}

function execCode(input, acc) {
  const code = String(input.code || '')
  try {
    const fn = new Function(`const logs=[];const console={log:(...a)=>logs.push(a.map(String).join(' ')),error:(...a)=>logs.push(a.map(String).join(' '))};const r=(function(){${code}})();return{r,logs}`)
    const { r, logs } = fn()
    const output = logs.length ? logs.join('\n') + (r !== undefined ? '\n→ ' + r : '') : String(r ?? '')
    acc.codeResults.push({ code, output })
    return output
  } catch (err) {
    acc.codeResults.push({ code, output: '', error: String(err) })
    return `Error: ${err}`
  }
}

// ── SSE reassembly (for proxies that force SSE even with stream:false) ──

function reassembleSSE(text) {
  const lines = text.split('\n')
  let content = '', finishReason = 'stop', usage = { prompt_tokens: 0, completion_tokens: 0 }
  const toolCalls = new Map()

  for (const line of lines) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
    try {
      const chunk = JSON.parse(line.slice(6))
      const delta = chunk.choices?.[0]?.delta
      if (!delta) { if (chunk.usage) usage = chunk.usage; continue }
      if (delta.content) content += delta.content
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          const ex = toolCalls.get(idx)
          if (!ex) toolCalls.set(idx, { id: tc.id || '', name: tc.function?.name || '', args: tc.function?.arguments || '' })
          else if (tc.function?.arguments) ex.args += tc.function.arguments
        }
      }
      const item = chunk.item
      if (item?.call_id) {
        let found = false
        for (const [, tc] of toolCalls) {
          if (tc.id === item.call_id) { if (item.name) tc.name = item.name; if (item.arguments) tc.args = item.arguments; found = true; break }
        }
        if (!found) toolCalls.set(toolCalls.size, { id: item.call_id, name: item.name || '', args: item.arguments || '' })
      }
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason
    } catch {}
  }

  const reassembled = [...toolCalls.values()].map(tc => ({ id: tc.id, function: { name: tc.name, arguments: tc.args } }))
  return {
    choices: [{ message: { content: content || null, tool_calls: reassembled.length ? reassembled : undefined }, finish_reason: reassembled.length ? 'tool_calls' : finishReason }],
    usage,
  }
}

// ── Proxy Support ──
async function callLLM(url, headers, body, proxyUrl) {
  if (proxyUrl) {
    const res = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url, method: 'POST', headers, body, mode: 'raw'
      })
    })
    const result = await res.json()
    if (!result.success) throw new Error(result.error || 'Proxy request failed')
    return { ok: result.status >= 200 && result.status < 300, status: result.status, text: () => result.body, json: () => JSON.parse(result.body) }
  } else {
    return await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  }
}
