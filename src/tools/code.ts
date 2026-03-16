// Code execution tool — lightweight JS sandbox

import type { ToolDefinition } from '../providers/provider.js'
import type { CodeResult } from '../types.js'

export const codeToolDef: ToolDefinition = {
  name: 'code_exec',
  description: 'Execute JavaScript code to perform calculations, data processing, or analysis. Returns the result of the last expression.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JavaScript code to execute' },
    },
    required: ['code'],
  },
}

interface CodeConfig {
  timeout?: number
}

export async function executeCode(
  input: Record<string, unknown>,
  config?: CodeConfig
): Promise<CodeResult> {
  const code = String(input.code ?? '')
  if (!code) return { code: '', output: '', error: 'No code provided' }

  const timeout = config?.timeout ?? 5000

  try {
    const result = await runWithTimeout(code, timeout)
    return { code, output: String(result) }
  } catch (err) {
    return { code, output: '', error: String(err) }
  }
}

function runWithTimeout(code: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Code execution timed out (${timeoutMs}ms)`)), timeoutMs)
    try {
      // Simple eval sandbox — for production, use isolated-vm or quickjs-emscripten
      const fn = new Function('console', `
        const logs = [];
        const _console = { log: (...a) => logs.push(a.map(String).join(' ')), error: (...a) => logs.push(a.map(String).join(' ')) };
        const result = (function() { ${code} })();
        return { result, logs };
      `)
      const { result, logs } = fn(console)
      clearTimeout(timer)
      const output = logs.length > 0 ? logs.join('\n') + (result !== undefined ? '\n→ ' + String(result) : '') : String(result ?? '')
      resolve(output)
    } catch (err) {
      clearTimeout(timer)
      reject(err)
    }
  })
}
