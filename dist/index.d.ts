interface AgenticConfig {
    /** LLM provider: 'anthropic' | 'openai' | 'custom' */
    provider?: 'anthropic' | 'openai' | 'custom';
    /** API key for the provider */
    apiKey: string;
    /** Base URL (for custom/proxy providers) */
    baseUrl?: string;
    /** Model name */
    model?: string;
    /** Which tools to enable */
    tools?: ToolName[];
    /** Tool-specific config */
    toolConfig?: {
        search?: {
            apiKey?: string;
            provider?: 'tavily' | 'serper';
        };
        code?: {
            timeout?: number;
        };
    };
}
type ToolName = 'search' | 'code' | 'file';
interface AgenticResult {
    /** Final answer text */
    answer: string;
    /** Sources used (from search) */
    sources?: Source[];
    /** Images from search results */
    images?: string[];
    /** Code execution results */
    codeResults?: CodeResult[];
    /** Files read/written */
    files?: FileResult[];
    /** Raw tool calls made */
    toolCalls?: ToolCall[];
    /** Token usage */
    usage?: {
        input: number;
        output: number;
    };
}
interface Source {
    title: string;
    url: string;
    snippet?: string;
}
interface CodeResult {
    code: string;
    output: string;
    error?: string;
}
interface FileResult {
    path: string;
    action: 'read' | 'write';
    content?: string;
}
interface ToolCall {
    tool: string;
    input: Record<string, unknown>;
    output: unknown;
}

declare function ask(prompt: string, config: AgenticConfig): Promise<AgenticResult>;

interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}
interface ProviderToolCall {
    id: string;
    name: string;
    input: Record<string, unknown>;
}
interface ProviderResponse {
    text: string;
    toolCalls: ProviderToolCall[];
    usage: {
        input: number;
        output: number;
    };
    stopReason: 'end' | 'tool_use';
    /** Raw content blocks for assistant message replay (Anthropic needs this) */
    rawContent?: unknown[];
}
interface ProviderMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string | ProviderToolContent[] | unknown[];
}
interface ProviderToolContent {
    type: 'tool_result';
    toolCallId: string;
    content: string;
}
interface Provider {
    chat(messages: ProviderMessage[], tools: ToolDefinition[]): Promise<ProviderResponse>;
}
declare function createProvider(config: AgenticConfig): Provider;

export { type AgenticConfig, type AgenticResult, type CodeResult, type FileResult, type Provider, type Source, type ToolCall, type ToolName, ask, createProvider };
