// agentic-lite — Core agent loop
// One function call, structured result with tool use

import { createProvider } from './providers/index.js'
import type { Provider, ProviderMessage, ToolDefinition, ProviderToolCall } from './providers/index.js'
import type { AgenticConfig, AgenticResult, ToolName, Source, CodeResult, FileResult, ToolCall } from './types.js'
import { searchToolDef, executeSearch } from './tools/search.js'
import { codeToolDef, executeCode } from './tools/code.js'
import { fileReadToolDef, fileWriteToolDef, executeFileRead, executeFileWrite } from './tools/file.js'

const MAX_TOOL_ROUNDS = 10

export async function ask(prompt: string, config: AgenticConfig): Promise<AgenticResult> {
  const provider = createProvider(config)
  const enabledTools = config.tools ?? ['search']
  const toolDefs = buildToolDefs(enabledTools)

  const messages: ProviderMessage[] = [{ role: 'user', content: prompt }]
  const allToolCalls: ToolCall[] = []
  const allSources: Source[] = []
  const allCodeResults: CodeResult[] = []
  const allFileResults: FileResult[] = []
  const allImages: string[] = []
  let totalUsage = { input: 0, output: 0 }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await provider.chat(messages, toolDefs)
    totalUsage.input += response.usage.input
    totalUsage.output += response.usage.output

    if (response.stopReason !== 'tool_use' || response.toolCalls.length === 0) {
      return {
        answer: response.text,
        sources: allSources.length > 0 ? allSources : undefined,
        images: allImages.length > 0 ? allImages : undefined,
        codeResults: allCodeResults.length > 0 ? allCodeResults : undefined,
        files: allFileResults.length > 0 ? allFileResults : undefined,
        toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
        usage: totalUsage,
      }
    }

    // Execute tool calls
    const toolResults = await executeToolCalls(response.toolCalls, config, {
      allSources, allCodeResults, allFileResults, allToolCalls, allImages,
    })

    // Build conversation continuation with tool results as text summary
    // Then do a final call WITHOUT tools to force the model to answer
    const callSummary = response.toolCalls.map(tc =>
      `I called ${tc.name}(${JSON.stringify(tc.input)})`
    ).join('\n')
    const resultSummary = toolResults.map(r => r.content).join('\n')
    const assistantText = [response.text, callSummary].filter(Boolean).join('\n')
    messages.push({ role: 'assistant', content: assistantText })
    messages.push({ role: 'user', content: `Here are the tool results:\n${resultSummary}\n\nPlease provide the final answer based on these results.` })

    // Final call without tools — force the model to synthesize and answer
    const finalResponse = await provider.chat(messages, [])
    totalUsage.input += finalResponse.usage.input
    totalUsage.output += finalResponse.usage.output

    return {
      answer: finalResponse.text,
      sources: allSources.length > 0 ? allSources : undefined,
      codeResults: allCodeResults.length > 0 ? allCodeResults : undefined,
      files: allFileResults.length > 0 ? allFileResults : undefined,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
      usage: totalUsage,
    }
  }

  throw new Error(`Agent loop exceeded ${MAX_TOOL_ROUNDS} rounds`)
}

// --- Tool execution ---

interface Accumulators {
  allSources: Source[]
  allCodeResults: CodeResult[]
  allFileResults: FileResult[]
  allToolCalls: ToolCall[]
  allImages: string[]
}

async function executeToolCalls(
  toolCalls: ProviderToolCall[],
  config: AgenticConfig,
  acc: Accumulators,
): Promise<{ type: 'tool_result'; toolCallId: string; content: string }[]> {
  const results = []

  for (const tc of toolCalls) {
    const output = await executeSingleTool(tc, config, acc)
    acc.allToolCalls.push({ tool: tc.name, input: tc.input, output })
    results.push({ type: 'tool_result' as const, toolCallId: tc.id, content: String(output) })
  }

  return results
}

async function executeSingleTool(
  tc: ProviderToolCall,
  config: AgenticConfig,
  acc: Accumulators,
): Promise<string> {
  switch (tc.name) {
    case 'web_search': {
      const result = await executeSearch(tc.input, config.toolConfig?.search)
      acc.allSources.push(...result.sources)
      if (result.images) acc.allImages.push(...result.images)
      return result.text
    }
    case 'code_exec': {
      const result = await executeCode(tc.input, config.toolConfig?.code)
      acc.allCodeResults.push(result)
      return result.error ? `Error: ${result.error}` : result.output
    }
    case 'file_read': {
      const result = await executeFileRead(tc.input)
      acc.allFileResults.push(result)
      return result.content ?? 'File read complete'
    }
    case 'file_write': {
      const result = await executeFileWrite(tc.input)
      acc.allFileResults.push(result)
      return result.content ?? 'File written'
    }
    default:
      return `Unknown tool: ${tc.name}`
  }
}

function buildToolDefs(tools: ToolName[]): ToolDefinition[] {
  const defs: ToolDefinition[] = []
  if (tools.includes('search')) defs.push(searchToolDef)
  if (tools.includes('code')) defs.push(codeToolDef)
  if (tools.includes('file')) {
    defs.push(fileReadToolDef)
    defs.push(fileWriteToolDef)
  }
  return defs
}
