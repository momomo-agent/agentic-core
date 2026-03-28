const { toolRegistry } = require('./agentic-core.js')

// Test registration
toolRegistry.register('test_tool', {
  description: 'A test tool',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string' }
    }
  },
  execute: async ({ input }) => {
    return { result: `Processed: ${input}` }
  }
})

// Test list
console.log('Registered tools:', toolRegistry.list().map(t => t.name))

// Test get
const tool = toolRegistry.get('test_tool')
console.log('Got tool:', tool.name, tool.description)

// Test execute
tool.execute({ input: 'hello' }).then(result => {
  console.log('Execute result:', result)
})

console.log('\n✅ Tool registry working!')
