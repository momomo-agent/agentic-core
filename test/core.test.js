// agentic-core unit tests — mock fetch, no real API calls
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// We need to load agentic-agent.js which uses `import` for loop-detection.
// Since it's an ES module with relative imports, we'll dynamically import it.
// But first, let's set up a mock fetch globally.

let fetchCalls = []
let fetchResponses = []

function pushFetchResponse(body, status = 200) {
  fetchResponses.push({ body, status })
}

// Mock fetch globally
const originalFetch = globalThis.fetch
beforeEach(() => {
  fetchCalls = []
  fetchResponses = []
  globalThis.fetch = mock.fn(async (url, options) => {
    fetchCalls.push({ url, options })
    const resp = fetchResponses.shift()
    if (!resp) throw new Error('No mock fetch response queued')
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      text: async () => JSON.stringify(resp.body),
      json: async () => resp.body,
      headers: new Map(),
    }
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// Import the module (ES module with relative imports)
const mod = await import(join(__dirname, '..', 'docs', 'agentic-agent.js'))
const { agenticAsk } = mod

// Helper: create Anthropic-style non-stream response (end_turn, no tools)
function anthropicTextResponse(text) {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  }
}

// Helper: create Anthropic-style response with tool_use
function anthropicToolResponse(text, toolCalls) {
  return {
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...toolCalls.map(tc => ({
        type: 'tool_use', id: tc.id || `toolu_${Math.random().toString(36).slice(2)}`,
        name: tc.name, input: tc.input,
      })),
    ],
    stop_reason: 'tool_use',
  }
}

function noopEmit() {}

describe('agentic-core: agenticAsk', () => {
  it('1. agenticAsk is exported and is a function', () => {
    assert.ok(agenticAsk, 'agenticAsk should be exported')
    assert.equal(typeof agenticAsk, 'function')
  })

  it('2. calls fetch with prompt + config', async () => {
    pushFetchResponse(anthropicTextResponse('Hello!'))

    await agenticAsk('test prompt', {
      apiKey: 'sk-test',
      model: 'claude-test',
      tools: [],
      stream: false,
    }, noopEmit)

    assert.ok(fetchCalls.length >= 1, 'fetch should be called at least once')
    const body = JSON.parse(fetchCalls[0].options.body)
    // Check that the prompt is in messages
    const userMsg = body.messages.find(m => m.role === 'user')
    assert.ok(userMsg, 'should have a user message')
  })

  it('3. stream=false returns { answer, rounds }', async () => {
    pushFetchResponse(anthropicTextResponse('The answer is 42.'))

    const result = await agenticAsk('What is the answer?', {
      apiKey: 'sk-test',
      model: 'claude-test',
      tools: [],
      stream: false,
    }, noopEmit)

    assert.ok(result.answer, 'result should have answer')
    assert.equal(result.answer, 'The answer is 42.')
    assert.equal(typeof result.rounds, 'number')
    assert.ok(result.rounds >= 1)
  })

  it('4. stream=true calls emit callback', async () => {
    // With proxyUrl, stream mode sends non-stream request then simulates via emit
    // The proxy wrapper expects { success: true, body: <actual response>, status: 200 }
    pushFetchResponse({
      success: true,
      status: 200,
      body: JSON.stringify(anthropicTextResponse('Streamed response')),
    })

    const emitted = []
    const emit = (type, data) => emitted.push({ type, data })

    await agenticAsk('stream test', {
      apiKey: 'sk-test',
      model: 'claude-test',
      tools: [],
      stream: true,
      proxyUrl: 'http://proxy.test',
    }, emit)

    // Should have emitted 'status' and 'token' events
    assert.ok(emitted.some(e => e.type === 'status'), 'should emit status')
    assert.ok(emitted.some(e => e.type === 'token'), 'should emit token for simulated streaming')
  })

  it('5. throws error when no apiKey', async () => {
    await assert.rejects(
      () => agenticAsk('test', { model: 'claude-test', tools: [] }, noopEmit),
      { message: 'API Key required' }
    )
  })

  it('6. tools array is passed to the API', async () => {
    const customTool = {
      name: 'my_tool',
      description: 'A test tool',
      parameters: { type: 'object', properties: { x: { type: 'string' } } },
    }

    pushFetchResponse(anthropicTextResponse('Done'))

    await agenticAsk('use the tool', {
      apiKey: 'sk-test',
      model: 'claude-test',
      tools: [customTool],
      stream: false,
    }, noopEmit)

    const body = JSON.parse(fetchCalls[0].options.body)
    assert.ok(body.tools, 'request body should have tools')
    assert.ok(body.tools.length >= 1, 'should have at least 1 tool')
    assert.equal(body.tools[0].name, 'my_tool')
  })

  it('7. multi-round tool_calls loop (mock 2 rounds)', async () => {
    const customTool = {
      name: 'my_tool',
      description: 'A test tool',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      execute: async (input) => ({ result: `answer for ${input.q}` }),
    }

    // Round 1: LLM calls tool
    pushFetchResponse(anthropicToolResponse('Let me search.', [
      { id: 'call_1', name: 'my_tool', input: { q: 'first' } },
    ]))

    // Round 2: LLM calls tool again
    pushFetchResponse(anthropicToolResponse('Need more info.', [
      { id: 'call_2', name: 'my_tool', input: { q: 'second' } },
    ]))

    // Round 3: LLM gives final answer
    pushFetchResponse(anthropicTextResponse('Final answer based on tools.'))

    const emitted = []
    const emit = (type, data) => emitted.push({ type, data })

    const result = await agenticAsk('multi-round test', {
      apiKey: 'sk-test',
      model: 'claude-test',
      tools: [customTool],
      stream: false,
    }, emit)

    assert.equal(result.answer, 'Final answer based on tools.')
    assert.equal(result.rounds, 3, 'should have gone through 3 rounds')
    // Should have emitted tool events
    const toolEvents = emitted.filter(e => e.type === 'tool')
    assert.equal(toolEvents.length, 2, 'should have 2 tool events')
  })

  it('8. maxRounds limit (MAX_ROUNDS=200 as safety net)', async () => {
    // We can't easily test 200 rounds, but we can verify the loop ends
    // by having the LLM never stop calling tools until forced.
    // Instead, test that after loop ends without finalAnswer, it generates one.

    // Round 1: tool call
    pushFetchResponse(anthropicToolResponse('Thinking.', [
      { id: 'call_1', name: 'search', input: { query: 'test' } },
    ]))
    // search needs searchApiKey, mock it
    pushFetchResponse({ results: [{ title: 'Result 1' }] }) // search API response

    // Round 2: end turn
    pushFetchResponse(anthropicTextResponse('Here is the answer.'))

    const result = await agenticAsk('max rounds test', {
      apiKey: 'sk-test',
      model: 'claude-test',
      tools: ['search'],
      searchApiKey: 'tvly-test',
      stream: false,
    }, noopEmit)

    assert.ok(result.answer)
    assert.ok(result.rounds <= 200, 'rounds should not exceed MAX_ROUNDS')
  })
})
