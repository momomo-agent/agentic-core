# agentic-core

AI agent engine — LLM calls, tools, schema, streaming. Zero dependencies.

Part of the [agentic](https://momomo-agent.github.io/agentic/) family.

## Install

```html
<script src="https://unpkg.com/agentic-core/agentic-core.js"></script>
```

```bash
npm install agentic-core
```

## Usage

```js
const { agenticAsk } = require('agentic-core')

// Simple call
const result = await agenticAsk('Hello', {
  provider: 'anthropic',
  apiKey: 'sk-...',
})
console.log(result.answer)

// With tools
const result = await agenticAsk('What is the weather?', {
  apiKey: 'sk-...',
  tools: [{
    name: 'get_weather',
    description: 'Get current weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
    execute: ({ city }) => `${city}: 25°C, sunny`
  }]
})

// Structured output
const result = await agenticAsk('Extract: John is 28 from Beijing', {
  apiKey: 'sk-...',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'number' },
      city: { type: 'string' }
    },
    required: ['name', 'age', 'city']
  }
})
console.log(result.data) // { name: 'John', age: 28, city: 'Beijing' }

// Streaming
await agenticAsk('Tell me a story', {
  apiKey: 'sk-...',
  stream: true,
}, (event, data) => {
  if (event === 'token') process.stdout.write(data.text)
})
```

## Tool Registry

Register tools globally, then use them in any `agenticAsk` call without passing them explicitly.

```js
const { toolRegistry } = require('agentic-core')

// Register a tool
toolRegistry.register('weather', {
  description: 'Get current weather for a city',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' }
    },
    required: ['city']
  },
  execute: async ({ city }) => {
    // Your implementation
    return { temperature: 25, condition: 'sunny' }
  }
})

// Now it's automatically available
const result = await agenticAsk('What is the weather in Beijing?', {
  apiKey: 'sk-...',
  tools: [] // Registry tools are auto-included
})

// List all registered tools
const tools = toolRegistry.list()

// Get a specific tool
const weatherTool = toolRegistry.get('weather')

// Unregister
toolRegistry.unregister('weather')

// Clear all
toolRegistry.clear()
```

## Features

- **Multi-provider**: Anthropic, OpenAI, any OpenAI-compatible API
- **Tool registry**: Register tools globally, auto-discover in all calls
- **Tool execution**: Built-in search/code + custom tools
- **Schema mode**: JSON validation + auto-retry for structured output
- **Streaming**: SSE with token events, proxy-compatible
- **Loop detection**: Prevents infinite tool call loops
- **Proxy support**: Works behind firewalls (GFW-compatible)
- **Zero dependencies**: Single file, ~5KB gzip

## License

MIT
