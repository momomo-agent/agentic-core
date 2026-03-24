/**
 * agentic-core — AI agent engine
 * Zero dependencies. LLM calls + Agent Loop + Tool execution + Loop detection.
 * UMD build — works with <script>, CommonJS, and AMD.
 *
 * Usage (browser):  <script src="agentic-core.umd.js"></script>
 *   AgenticCore.agenticAsk('hello', { apiKey: '...', provider: 'anthropic' }, console.log)
 *
 * Usage (Node):  const { agenticAsk } = require('./agentic-core.umd.js')
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else if (typeof define === 'function' && define.amd) define(factory)
  else { var f = factory(); root.AgenticCore = f; root.AgenticAgent = f }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

// ── Loop Detection (inlined) ──

// loop-detection.js — 完全对齐 OpenClaw tool-loop-detection.ts
// 浏览器端实现（无 node:crypto，用简单哈希替代）

const WARNING_THRESHOLD = 10
const CRITICAL_THRESHOLD = 20
const GLOBAL_CIRCUIT_BREAKER_THRESHOLD = 30
const TOOL_CALL_HISTORY_SIZE = 30

// ── Hash helpers (browser-safe) ──

function simpleHash(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(16)
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

function hashToolCall(toolName, params) {
  return `${toolName}:${simpleHash(stableStringify(params))}`
}

function hashToolOutcome(toolName, params, result, error) {
  if (error !== undefined) {
    return `error:${simpleHash(String(error))}`
  }
  if (result === undefined) return undefined

  // Extract text content (OpenClaw format)
  let text = ''
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    text = result.content
      .filter(e => e && typeof e.type === 'string' && typeof e.text === 'string')
      .map(e => e.text)
      .join('\n')
      .trim()
  }

  const details = (result && typeof result === 'object' && result.details) || {}

  // Known poll tools get special hashing
  if (isKnownPollToolCall(toolName, params)) {
    if (typeof params === 'object' && params !== null) {
      const action = params.action
      if (action === 'poll') {
        return simpleHash(stableStringify({
          action, status: details.status,
          exitCode: details.exitCode ?? null, exitSignal: details.exitSignal ?? null,
          aggregated: details.aggregated ?? null, text,
        }))
      }
      if (action === 'log') {
        return simpleHash(stableStringify({
          action, status: details.status,
          totalLines: details.totalLines ?? null, totalChars: details.totalChars ?? null,
          truncated: details.truncated ?? null,
          exitCode: details.exitCode ?? null, exitSignal: details.exitSignal ?? null, text,
        }))
      }
    }
  }

  return simpleHash(stableStringify({ details, text }))
}

function isKnownPollToolCall(toolName, params) {
  if (toolName === 'command_status') return true
  if (toolName !== 'process' || typeof params !== 'object' || params === null) return false
  return params.action === 'poll' || params.action === 'log'
}

// ── No-progress streak ──

function getNoProgressStreak(history, toolName, argsHash) {
  let streak = 0
  let latestResultHash = undefined

  for (let i = history.length - 1; i >= 0; i--) {
    const record = history[i]
    if (!record || record.toolName !== toolName || record.argsHash !== argsHash) continue
    if (typeof record.resultHash !== 'string' || !record.resultHash) continue

    if (!latestResultHash) {
      latestResultHash = record.resultHash
      streak = 1
      continue
    }
    if (record.resultHash !== latestResultHash) break
    streak++
  }

  return { count: streak, latestResultHash }
}

// ── Ping-pong detection ──

function getPingPongStreak(history, currentHash) {
  const last = history[history.length - 1]
  if (!last) return { count: 0, noProgressEvidence: false }

  let otherSignature, otherToolName
  for (let i = history.length - 2; i >= 0; i--) {
    const call = history[i]
    if (!call) continue
    if (call.argsHash !== last.argsHash) {
      otherSignature = call.argsHash
      otherToolName = call.toolName
      break
    }
  }

  if (!otherSignature || !otherToolName) return { count: 0, noProgressEvidence: false }

  let alternatingTailCount = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const call = history[i]
    if (!call) continue
    const expected = alternatingTailCount % 2 === 0 ? last.argsHash : otherSignature
    if (call.argsHash !== expected) break
    alternatingTailCount++
  }

  if (alternatingTailCount < 2) return { count: 0, noProgressEvidence: false }
  if (currentHash !== otherSignature) return { count: 0, noProgressEvidence: false }

  const tailStart = Math.max(0, history.length - alternatingTailCount)
  let firstHashA, firstHashB
  let noProgressEvidence = true

  for (let i = tailStart; i < history.length; i++) {
    const call = history[i]
    if (!call || !call.resultHash) { noProgressEvidence = false; break }

    if (call.argsHash === last.argsHash) {
      if (!firstHashA) firstHashA = call.resultHash
      else if (firstHashA !== call.resultHash) { noProgressEvidence = false; break }
    } else if (call.argsHash === otherSignature) {
      if (!firstHashB) firstHashB = call.resultHash
      else if (firstHashB !== call.resultHash) { noProgressEvidence = false; break }
    } else {
      noProgressEvidence = false; break
    }
  }

  if (!firstHashA || !firstHashB) noProgressEvidence = false

  return {
    count: alternatingTailCount + 1,
    pairedToolName: last.toolName,
    pairedSignature: last.argsHash,
    noProgressEvidence,
  }
}

// ── Main detection (exact OpenClaw logic) ──

function detectToolCallLoop(state, toolName, params) {
  const history = state.toolCallHistory || []
  const currentHash = hashToolCall(toolName, params)
  const noProgress = getNoProgressStreak(history, toolName, currentHash)
  const noProgressStreak = noProgress.count
  const knownPollTool = isKnownPollToolCall(toolName, params)
  const pingPong = getPingPongStreak(history, currentHash)

  // 1. Global circuit breaker
  if (noProgressStreak >= GLOBAL_CIRCUIT_BREAKER_THRESHOLD) {
    return {
      stuck: true, level: 'critical', detector: 'global_circuit_breaker',
      count: noProgressStreak,
      message: `CRITICAL: ${toolName} has repeated identical no-progress outcomes ${noProgressStreak} times. Session execution blocked by global circuit breaker to prevent runaway loops.`,
    }
  }

  // 2. Known poll no-progress (critical)
  if (knownPollTool && noProgressStreak >= CRITICAL_THRESHOLD) {
    return {
      stuck: true, level: 'critical', detector: 'known_poll_no_progress',
      count: noProgressStreak,
      message: `CRITICAL: Called ${toolName} with identical arguments and no progress ${noProgressStreak} times. This appears to be a stuck polling loop. Session execution blocked to prevent resource waste.`,
    }
  }

  // 3. Known poll no-progress (warning)
  if (knownPollTool && noProgressStreak >= WARNING_THRESHOLD) {
    return {
      stuck: true, level: 'warning', detector: 'known_poll_no_progress',
      count: noProgressStreak,
      message: `WARNING: You have called ${toolName} ${noProgressStreak} times with identical arguments and no progress. Stop polling and either (1) increase wait time between checks, or (2) report the task as failed if the process is stuck.`,
    }
  }

  // 4. Ping-pong (critical)
  if (pingPong.count >= CRITICAL_THRESHOLD && pingPong.noProgressEvidence) {
    return {
      stuck: true, level: 'critical', detector: 'ping_pong',
      count: pingPong.count,
      message: `CRITICAL: You are alternating between repeated tool-call patterns (${pingPong.count} consecutive calls) with no progress. This appears to be a stuck ping-pong loop. Session execution blocked to prevent resource waste.`,
      pairedToolName: pingPong.pairedToolName,
    }
  }

  // 5. Ping-pong (warning)
  if (pingPong.count >= WARNING_THRESHOLD) {
    return {
      stuck: true, level: 'warning', detector: 'ping_pong',
      count: pingPong.count,
      message: `WARNING: You are alternating between repeated tool-call patterns (${pingPong.count} consecutive calls). This looks like a ping-pong loop; stop retrying and report the task as failed.`,
      pairedToolName: pingPong.pairedToolName,
    }
  }

  // 6. Generic repeat (warning only, identical args)
  const recentCount = history.filter(
    h => h.toolName === toolName && h.argsHash === currentHash
  ).length

  if (!knownPollTool && recentCount >= WARNING_THRESHOLD) {
    return {
      stuck: true, level: 'warning', detector: 'generic_repeat',
      count: recentCount,
      message: `WARNING: You have called ${toolName} ${recentCount} times with identical arguments. If this is not making progress, stop retrying and report the task as failed.`,
    }
  }

  return { stuck: false }
}

// ── Record helpers ──

function recordToolCall(state, toolName, params) {
  if (!state.toolCallHistory) state.toolCallHistory = []

  state.toolCallHistory.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    timestamp: Date.now(),
  })

  if (state.toolCallHistory.length > TOOL_CALL_HISTORY_SIZE) {
    state.toolCallHistory.shift()
  }
}

function recordToolCallOutcome(state, toolName, params, result, error) {
  if (!state.toolCallHistory) state.toolCallHistory = []

  const argsHash = hashToolCall(toolName, params)
  const resultHash = hashToolOutcome(toolName, params, result, error)
  if (!resultHash) return

  // Find last matching unresolved record
  let matched = false
  for (let i = state.toolCallHistory.length - 1; i >= 0; i--) {
    const call = state.toolCallHistory[i]
    if (!call || call.toolName !== toolName || call.argsHash !== argsHash) continue
    if (call.resultHash !== undefined) continue
    call.resultHash = resultHash
    matched = true
    break
  }

  if (!matched) {
    state.toolCallHistory.push({
      toolName, argsHash, resultHash, timestamp: Date.now(),
    })
  }

  if (state.toolCallHistory.length > TOOL_CALL_HISTORY_SIZE) {
    state.toolCallHistory.splice(0, state.toolCallHistory.length - TOOL_CALL_HISTORY_SIZE)
  }
}


// ── Agent Core ──

// agentic-agent.js - 前端 Agent Loop
// 完全端侧运行，通过可配置的 proxy 调用 LLM
// 支持流式输出 (stream) + 智能循环检测（对齐 OpenClaw）


const MAX_ROUNDS = 200  // 安全兜底，实际由循环检测控制（与 OpenClaw 一致）

async function agenticAsk(prompt, config, emit) {
  try {
    return await _agenticAsk(prompt, config, emit)
  } catch (e) {
    // Ensure all errors are Error instances
    throw e instanceof Error ? e : new Error(String(e))
  }
}

async function _agenticAsk(prompt, config, emit) {
  const { provider = 'anthropic', baseUrl, apiKey, model, tools = ['search', 'code'], searchApiKey, history, proxyUrl, stream = true, schema, retries = 2, system, images } = config
  
  if (!apiKey) throw new Error('API Key required')
  
  // Schema mode: structured output with validation + retry
  if (schema) {
    return await schemaAsk(prompt, config, emit)
  }
  
  const { defs: toolDefs, customTools } = buildToolDefs(tools)
  
  // Build messages
  const messages = []
  if (history?.length) {
    messages.push(...history)
  }
  
  // Build user message — support vision (images)
  if (images?.length) {
    const content = []
    for (const img of images) {
      if (provider === 'anthropic') {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type || 'image/jpeg', data: img.data } })
      } else {
        const url = img.url || `data:${img.media_type || 'image/jpeg'};base64,${img.data}`
        content.push({ type: 'image_url', image_url: { url, detail: img.detail || 'low' } })
      }
    }
    content.push({ type: 'text', text: prompt })
    messages.push({ role: 'user', content })
  } else {
    messages.push({ role: 'user', content: prompt })
  }
  
  let round = 0
  let finalAnswer = null
  const state = { toolCallHistory: [] }  // 循环检测状态
  
  console.log('[agenticAsk] Starting with prompt:', prompt.slice(0, 50))
  console.log('[agenticAsk] Tools available:', tools, 'Stream:', stream)
  console.log('[agenticAsk] Provider:', provider)
  
  while (round < MAX_ROUNDS) {
    round++
    console.log(`\n[Round ${round}] Calling LLM...`)
    emit('status', { message: `Round ${round}/${MAX_ROUNDS}` })
    
    // Call LLM (stream on final round or when no tools)
    const isStreamRound = stream && (!toolDefs.length || round > 1)
    const chatFn = provider === 'anthropic' ? anthropicChat : openaiChat
    const response = await chatFn({ messages, tools: toolDefs, model, baseUrl, apiKey, proxyUrl, stream: isStreamRound, emit, system })
    
    console.log(`[Round ${round}] LLM Response:`)
    console.log(`  - stop_reason: ${response.stop_reason}`)
    console.log(`  - content: ${response.content.slice(0, 100)}...`)
    console.log(`  - tool_calls: ${response.tool_calls?.length || 0}`)
    
    // Check if done
    if (['end_turn', 'stop'].includes(response.stop_reason) || !response.tool_calls?.length) {
      console.log(`[Round ${round}] Done: stop_reason=${response.stop_reason}, tool_calls=${response.tool_calls?.length || 0}`)
      finalAnswer = response.content
      break
    }
    
    // Execute tools
    console.log(`[Round ${round}] Executing ${response.tool_calls.length} tool calls...`)
    // Normalize tool_calls to OpenAI format for multi-round consistency
    const normalizedCalls = response.tool_calls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) },
      // Keep original fields for internal use
      name: tc.name,
      input: tc.input,
    }))
    messages.push({ role: 'assistant', content: response.content, tool_calls: normalizedCalls })
    
    for (const call of response.tool_calls) {
      console.log(`[Round ${round}] Tool: ${call.name}, Input:`, JSON.stringify(call.input).slice(0, 100))
      
      recordToolCall(state, call.name, call.input)
      
      const loopDetection = detectToolCallLoop(state, call.name, call.input)
      if (loopDetection.stuck) {
        console.log(`[Round ${round}] Loop detected: ${loopDetection.detector} (${loopDetection.level})`)
        emit('warning', { level: loopDetection.level, message: loopDetection.message })
        if (loopDetection.level === 'critical') {
          finalAnswer = `[Loop Detection] ${loopDetection.message}`
          break
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: `LOOP_DETECTED: ${loopDetection.message}` }) })
        continue
      }
      
      emit('tool', { name: call.name, input: call.input })
      const result = await executeTool(call.name, call.input, { searchApiKey, customTools })
      console.log(`[Round ${round}] Tool result:`, JSON.stringify(result).slice(0, 100))
      
      recordToolCallOutcome(state, call.name, call.input, result, null)
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
    }
    
    if (finalAnswer) break
  }
  
  console.log(`\n[agenticAsk] Loop ended at round ${round}`)
  
  if (!finalAnswer) {
    console.log('[agenticAsk] Generating final answer (no tools)...')
    emit('status', { message: 'Generating final answer...' })
    const chatFn = provider === 'anthropic' ? anthropicChat : openaiChat
    const finalResponse = await chatFn({ messages, tools: [], model, baseUrl, apiKey, proxyUrl, stream, emit, system })
    finalAnswer = finalResponse.content || '(no response)'
    console.log('[agenticAsk] Final answer:', finalAnswer.slice(0, 100))
  }
  
  console.log('[agenticAsk] Complete. Total rounds:', round)
  return { answer: finalAnswer, rounds: round, messages }
}

// ── LLM Chat Functions ──

async function anthropicChat({ messages, tools, model = 'claude-sonnet-4', baseUrl = 'https://api.anthropic.com', apiKey, proxyUrl, stream = false, emit, system }) {
  const base = baseUrl.replace(/\/+$/, '')
  const url = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
  
  // Convert messages to Anthropic format (handle tool_use/tool_result)
  const anthropicMessages = []
  for (const m of messages) {
    if (m.role === 'user') {
      anthropicMessages.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      if (m.tool_calls?.length) {
        const blocks = []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const tc of m.tool_calls) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
        }
        anthropicMessages.push({ role: 'assistant', content: blocks })
      } else {
        anthropicMessages.push({ role: 'assistant', content: m.content })
      }
    } else if (m.role === 'tool') {
      const toolResult = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }
      const last = anthropicMessages[anthropicMessages.length - 1]
      if (last?.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(toolResult)
      } else {
        anthropicMessages.push({ role: 'user', content: [toolResult] })
      }
    }
  }
  
  const body = {
    model,
    max_tokens: 4096,
    messages: anthropicMessages,
    stream,
  }
  if (system) body.system = system
  if (tools?.length) body.tools = tools
  
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }

  if (stream && !proxyUrl) {
    // Stream mode — direct SSE
    return await streamAnthropic(url, headers, body, emit)
  }

  if (stream && proxyUrl) {
    // Stream via transparent proxy (Vercel Edge / similar)
    // Send stream:true request through proxy with custom headers
    const proxyHeaders = { ...headers, 'x-base-url': baseUrl || 'https://api.anthropic.com', 'x-provider': 'anthropic' }
    return await streamAnthropic(proxyUrl, proxyHeaders, body, emit)
  }

  const response = await callLLM(url, apiKey, body, proxyUrl, true)
  
  const text = response.content.find(c => c.type === 'text')?.text || ''
  
  return {
    content: text,
    tool_calls: response.content.filter(c => c.type === 'tool_use').map(t => ({
      id: t.id, name: t.name, input: t.input
    })),
    stop_reason: response.stop_reason
  }
}

async function openaiChat({ messages, tools, model = 'gpt-4', baseUrl = 'https://api.openai.com', apiKey, proxyUrl, stream = false, emit, system }) {
  const base = baseUrl.replace(/\/+$/, '')
  const url = base.includes('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
  const oaiMessages = system ? [{ role: 'system', content: system }, ...messages] : messages
  const body = { model, messages: oaiMessages, stream }
  if (tools?.length) body.tools = tools.map(t => ({ type: 'function', function: t }))
  
  const headers = { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` }

  if (stream && !proxyUrl) {
    return await streamOpenAI(url, headers, body, emit)
  }

  if (stream && proxyUrl) {
    const proxyHeaders = { ...headers, 'x-base-url': baseUrl || 'https://api.openai.com', 'x-provider': 'openai', 'x-api-key': apiKey }
    return await streamOpenAI(proxyUrl, proxyHeaders, body, emit)
  }

  const response = await callLLM(url, apiKey, body, proxyUrl, false)
  
  // Handle SSE response from non-stream endpoints
  if (typeof response === 'string' && response.includes('chat.completion.chunk')) {
    return parseSSEResponse(response)
  }
  
  const choice = response.choices?.[0]
  if (!choice) return { content: '', tool_calls: [], stop_reason: 'stop' }
  
  const text = choice.message?.content || ''
  
  return {
    content: text,
    tool_calls: choice.message?.tool_calls?.map(t => {
      let input = {}
      try { input = JSON.parse(t.function.arguments || '{}') } catch {}
      return { id: t.id, name: t.function.name, input }
    }) || [],
    stop_reason: choice.finish_reason
  }
}

// ── Streaming Functions ──

async function streamAnthropic(url, headers, body, emit) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`API error ${res.status}: ${err.slice(0, 300)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let toolCalls = []
  let currentToolInput = ''
  let currentTool = null
  let stopReason = 'end_turn'

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue
      try {
        const event = JSON.parse(data)
        
        if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta') {
            content += event.delta.text
            emit('token', { text: event.delta.text })
          } else if (event.delta?.type === 'input_json_delta') {
            currentToolInput += event.delta.partial_json || ''
          }
        } else if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'tool_use') {
            currentTool = { id: event.content_block.id, name: event.content_block.name }
            currentToolInput = ''
          }
        } else if (event.type === 'content_block_stop') {
          if (currentTool) {
            let input = {}
            try { input = JSON.parse(currentToolInput || '{}') } catch {}
            toolCalls.push({ ...currentTool, input })
            currentTool = null
            currentToolInput = ''
          }
        } else if (event.type === 'message_delta') {
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
        }
      } catch {}
    }
  }

  return { content, tool_calls: toolCalls, stop_reason: stopReason }
}

async function streamOpenAI(url, headers, body, emit) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`API error ${res.status}: ${err.slice(0, 300)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let toolCalls = {}
  let finishReason = 'stop'

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue
      try {
        const chunk = JSON.parse(data)
        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue

        if (delta.content) {
          content += delta.content
          emit('token', { text: delta.content })
        }
        if (chunk.choices?.[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: '', name: '', arguments: '' }
            if (tc.id) toolCalls[tc.index].id = tc.id
            if (tc.function?.name) toolCalls[tc.index].name = tc.function.name
            if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments
          }
        }
      } catch {}
    }
  }

  const tcList = Object.values(toolCalls).filter(t => t.name).map(t => {
    let input = {}
    try { input = JSON.parse(t.arguments || '{}') } catch {}
    return { id: t.id, name: t.name, input }
  })

  return { content, tool_calls: tcList, stop_reason: finishReason }
}

// ── Non-stream Proxy/Direct Call ──

async function callLLM(url, apiKey, body, proxyUrl, isAnthropic = false) {
  const headers = { 'content-type': 'application/json' }
  if (isAnthropic) {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers['authorization'] = `Bearer ${apiKey}`
  }
  
  if (proxyUrl) {
    // Transparent proxy — pass config via headers, body goes through directly
    const proxyHeaders = {
      ...headers,
      'x-base-url': url.replace(/\/v1\/.*$/, ''),
      'x-provider': isAnthropic ? 'anthropic' : 'openai',
      'x-api-key': apiKey,
    }
    const response = await fetch(proxyUrl, {
      method: 'POST',
      headers: proxyHeaders,
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`API error ${response.status}: ${text.slice(0, 300)}`)
    }
    return await response.json()
  } else {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`API error ${response.status}: ${text}`)
    }
    const text = await response.text()
    if (text.trimStart().startsWith('data: ')) return reassembleSSE(text)
    return JSON.parse(text)
  }
}

function parseSSEResponse(sseText) {
  const lines = sseText.split('\n')
  let textContent = ''
  const toolCalls = []
  let currentToolCall = null
  let lastChunkWasToolUse = false
  
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      let jsonStr = line
      if (line.includes('data: ')) jsonStr = line.split('data: ')[1]
      if (!jsonStr || !jsonStr.includes('{')) continue
      const startIdx = jsonStr.indexOf('{')
      const endIdx = jsonStr.lastIndexOf('}')
      if (startIdx === -1 || endIdx === -1) continue
      const chunk = JSON.parse(jsonStr.substring(startIdx, endIdx + 1))
      if (chunk.choices?.[0]?.delta?.content) {
        textContent += chunk.choices[0].delta.content
        lastChunkWasToolUse = false
      }
      if (chunk.name) {
        if (currentToolCall && currentToolCall.name !== chunk.name) toolCalls.push(currentToolCall)
        currentToolCall = { id: chunk.call_id || `call_${Date.now()}`, name: chunk.name, arguments: chunk.arguments || '' }
        lastChunkWasToolUse = true
      } else if (lastChunkWasToolUse && chunk.arguments !== undefined && currentToolCall) {
        currentToolCall.arguments += chunk.arguments
      }
    } catch {}
  }
  if (currentToolCall) toolCalls.push(currentToolCall)
  const parsedToolCalls = toolCalls.map(t => {
    let input = {}
    try { if (t.arguments.trim()) input = JSON.parse(t.arguments) } catch {}
    return { id: t.id, name: t.name, input }
  })
  return { content: textContent, tool_calls: parsedToolCalls, stop_reason: parsedToolCalls.length > 0 ? 'tool_use' : 'stop' }
}

function reassembleSSE(raw) {
  const lines = raw.split('\n')
  let content = ''
  let toolCalls = {}
  let model = ''
  let usage = null
  let finishReason = null
  for (const line of lines) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
    try {
      const chunk = JSON.parse(line.slice(6))
      if (chunk.model) model = chunk.model
      if (chunk.usage) usage = chunk.usage
      const delta = chunk.choices?.[0]?.delta
      if (!delta) continue
      if (delta.content) content += delta.content
      if (delta.finish_reason) finishReason = delta.finish_reason
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: '', name: '', arguments: '' }
          if (tc.id) toolCalls[tc.index].id = tc.id
          if (tc.function?.name) toolCalls[tc.index].name = tc.function.name
          if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments
        }
      }
    } catch {}
  }
  const tcList = Object.values(toolCalls).filter(t => t.name)
  return {
    choices: [{ message: { content, tool_calls: tcList.length ? tcList.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) : undefined }, finish_reason: finishReason || 'stop' }],
    model, usage: usage || { prompt_tokens: 0, completion_tokens: 0 }
  }
}

// ── Tools ──

function buildToolDefs(tools) {
  const defs = []
  const customTools = []
  
  for (const tool of tools) {
    if (typeof tool === 'string') {
      // Built-in tool
      if (tool === 'search') {
        defs.push({ name: 'search', description: 'Search the web for current information', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] } })
      } else if (tool === 'code') {
        defs.push({ name: 'execute_code', description: 'Execute Python code', input_schema: { type: 'object', properties: { code: { type: 'string', description: 'Python code to execute' } }, required: ['code'] } })
      }
    } else if (typeof tool === 'object' && tool.name) {
      // Custom tool
      defs.push({
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.parameters || tool.input_schema || { type: 'object', properties: {} }
      })
      customTools.push(tool)
    }
  }
  
  return { defs, customTools }
}

async function executeTool(name, input, config) {
  // Check custom tools first
  if (config.customTools) {
    const custom = config.customTools.find(t => t.name === name)
    if (custom && custom.execute) {
      return await custom.execute(input)
    }
  }
  
  // Built-in tools
  if (name === 'search') return await searchWeb(input.query, config.searchApiKey)
  if (name === 'execute_code') return { output: '[Code execution not available in browser]' }
  
  return { error: 'Unknown tool' }
}

async function searchWeb(query, apiKey) {
  if (!apiKey) return { error: 'Search API key required' }
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: 5 })
  })
  const data = await response.json()
  return { results: data.results || [] }
}

// ── Schema Mode (Structured Output) ──

async function schemaAsk(prompt, config, emit) {
  const { provider = 'anthropic', baseUrl, apiKey, model, history, proxyUrl, schema, retries = 2 } = config
  
  const schemaStr = JSON.stringify(schema, null, 2)
  const systemPrompt = `You must respond with valid JSON that matches this schema:\n${schemaStr}\n\nRules:\n- Output ONLY the JSON object, no markdown, no explanation, no code fences\n- All required fields must be present\n- Types must match exactly`
  
  const messages = []
  if (history?.length) messages.push(...history)
  messages.push({ role: 'user', content: prompt })
  
  let lastError = null
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`[schema] Retry ${attempt}/${retries}: ${lastError}`)
      emit('status', { message: `Retry ${attempt}/${retries}...` })
      // Add error feedback for retry
      messages.push({ role: 'assistant', content: lastError.raw })
      messages.push({ role: 'user', content: `That JSON was invalid: ${lastError.message}\n\nPlease fix and return ONLY valid JSON matching the schema.` })
    }
    
    emit('status', { message: attempt === 0 ? 'Generating structured output...' : `Retry ${attempt}/${retries}...` })
    
    const chatFn = provider === 'anthropic' ? anthropicChat : openaiChat
    const response = await chatFn({
      messages: [{ role: 'user', content: systemPrompt + '\n\n' + prompt }],
      tools: [], model, baseUrl, apiKey, proxyUrl, stream: false, emit
    })
    
    const raw = response.content.trim()
    
    // Try to extract JSON (handle markdown fences)
    let jsonStr = raw
    const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    if (fenceMatch) jsonStr = fenceMatch[1].trim()
    
    // Parse
    let parsed
    try {
      parsed = JSON.parse(jsonStr)
    } catch (e) {
      lastError = { message: `JSON parse error: ${e.message}`, raw }
      continue
    }
    
    // Validate against schema
    const validation = validateSchema(parsed, schema)
    if (!validation.valid) {
      lastError = { message: validation.error, raw }
      continue
    }
    
    // Success
    return { answer: raw, data: parsed, attempts: attempt + 1 }
  }
  
  // All retries exhausted
  throw new Error(`Schema validation failed after ${retries + 1} attempts: ${lastError.message}`)
}

function validateSchema(data, schema) {
  if (!schema || !schema.type) return { valid: true }
  
  // Type check
  if (schema.type === 'object') {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return { valid: false, error: `Expected object, got ${Array.isArray(data) ? 'array' : typeof data}` }
    }
    // Required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in data)) {
          return { valid: false, error: `Missing required field: "${field}"` }
        }
      }
    }
    // Property types
    if (schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (key in data && data[key] !== null && data[key] !== undefined) {
          const val = data[key]
          if (prop.type === 'string' && typeof val !== 'string') return { valid: false, error: `Field "${key}" should be string, got ${typeof val}` }
          if (prop.type === 'number' && typeof val !== 'number') return { valid: false, error: `Field "${key}" should be number, got ${typeof val}` }
          if (prop.type === 'boolean' && typeof val !== 'boolean') return { valid: false, error: `Field "${key}" should be boolean, got ${typeof val}` }
          if (prop.type === 'array' && !Array.isArray(val)) return { valid: false, error: `Field "${key}" should be array, got ${typeof val}` }
          // Enum check
          if (prop.enum && !prop.enum.includes(val)) return { valid: false, error: `Field "${key}" must be one of: ${prop.enum.join(', ')}` }
        }
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(data)) return { valid: false, error: `Expected array, got ${typeof data}` }
  } else if (schema.type === 'string') {
    if (typeof data !== 'string') return { valid: false, error: `Expected string, got ${typeof data}` }
  } else if (schema.type === 'number') {
    if (typeof data !== 'number') return { valid: false, error: `Expected number, got ${typeof data}` }
  }
  
  return { valid: true }
}


  return { agenticAsk }
})
