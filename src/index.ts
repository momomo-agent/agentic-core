// agentic-lite — Lightweight agent API
// One function call with built-in search, code execution, and file processing

export { ask } from './ask.js'
export type { AgenticConfig, AgenticResult, ToolName, Source, CodeResult, FileResult, ToolCall } from './types.js'
export { createProvider } from './providers/index.js'
export type { Provider } from './providers/index.js'
