// agentic-lite — Types

export interface AgenticConfig {
  /** LLM provider: 'anthropic' | 'openai' | 'custom' */
  provider?: 'anthropic' | 'openai' | 'custom'
  /** API key for the provider */
  apiKey: string
  /** Base URL (for custom/proxy providers) */
  baseUrl?: string
  /** Model name */
  model?: string
  /** Which tools to enable */
  tools?: ToolName[]
  /** Tool-specific config */
  toolConfig?: {
    search?: { apiKey?: string; provider?: 'tavily' | 'serper' }
    code?: { timeout?: number }
  }
}

export type ToolName = 'search' | 'code' | 'file'

export interface AgenticResult {
  /** Final answer text */
  answer: string
  /** Sources used (from search) */
  sources?: Source[]
  /** Images from search results */
  images?: string[]
  /** Code execution results */
  codeResults?: CodeResult[]
  /** Files read/written */
  files?: FileResult[]
  /** Raw tool calls made */
  toolCalls?: ToolCall[]
  /** Token usage */
  usage?: { input: number; output: number }
}

export interface Source {
  title: string
  url: string
  snippet?: string
}

export interface CodeResult {
  code: string
  output: string
  error?: string
}

export interface FileResult {
  path: string
  action: 'read' | 'write'
  content?: string
}

export interface ToolCall {
  tool: string
  input: Record<string, unknown>
  output: unknown
}
