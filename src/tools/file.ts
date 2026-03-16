// File tool — read/write local files

import { readFile, writeFile } from 'node:fs/promises'
import type { ToolDefinition } from '../providers/provider.js'
import type { FileResult } from '../types.js'

export const fileReadToolDef: ToolDefinition = {
  name: 'file_read',
  description: 'Read the contents of a local file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read' },
    },
    required: ['path'],
  },
}

export const fileWriteToolDef: ToolDefinition = {
  name: 'file_write',
  description: 'Write content to a local file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
}

export async function executeFileRead(input: Record<string, unknown>): Promise<FileResult> {
  const path = String(input.path ?? '')
  try {
    const content = await readFile(path, 'utf-8')
    return { path, action: 'read', content }
  } catch (err) {
    return { path, action: 'read', content: `Error: ${err}` }
  }
}

export async function executeFileWrite(input: Record<string, unknown>): Promise<FileResult> {
  const path = String(input.path ?? '')
  const content = String(input.content ?? '')
  try {
    await writeFile(path, content, 'utf-8')
    return { path, action: 'write' }
  } catch (err) {
    return { path, action: 'write', content: `Error: ${err}` }
  }
}
