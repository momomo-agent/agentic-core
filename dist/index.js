// src/providers/anthropic.ts
function createAnthropicProvider(config) {
  const base = (config.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const endpoint = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  const model = config.model ?? "claude-sonnet-4-20250514";
  return {
    async chat(messages, tools) {
      const body = {
        model,
        max_tokens: 4096,
        messages: convertMessages(messages)
      };
      if (tools.length > 0) {
        body.tools = tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters
        }));
      }
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Anthropic API error ${res.status}: ${err}`);
      }
      const data = await res.json();
      return parseResponse(data);
    }
  };
}
function convertMessages(messages) {
  return messages.map((m) => {
    if (m.role === "tool" && Array.isArray(m.content)) {
      return {
        role: "user",
        content: m.content.map((c) => ({
          type: "tool_result",
          tool_use_id: c.toolCallId,
          content: c.content
        }))
      };
    }
    return { role: m.role, content: m.content };
  });
}
function parseResponse(data) {
  let text = "";
  const toolCalls = [];
  for (const block of data.content) {
    if (block.type === "text" && block.text) {
      text += block.text;
    } else if (block.type === "tool_use" && block.id && block.name) {
      toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} });
    }
  }
  return {
    text,
    toolCalls,
    usage: { input: data.usage.input_tokens, output: data.usage.output_tokens },
    stopReason: data.stop_reason === "tool_use" ? "tool_use" : "end",
    rawContent: data.content
  };
}

// src/providers/openai.ts
function createOpenAIProvider(config) {
  const baseUrl = config.baseUrl ?? "https://api.openai.com";
  const model = config.model ?? "gpt-4o";
  return {
    async chat(messages, tools) {
      const body = {
        model,
        stream: false,
        messages: convertMessages2(messages)
      };
      if (tools.length > 0) {
        body.tools = tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters }
        }));
      }
      const base = baseUrl.replace(/\/+$/, "");
      const endpoint = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.apiKey}`
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenAI API error ${res.status}: ${err}`);
      }
      const rawText = await res.text();
      let data;
      if (rawText.trimStart().startsWith("data: ")) {
        data = reassembleSSE(rawText);
      } else {
        data = JSON.parse(rawText);
      }
      return parseResponse2(data);
    }
  };
}
function reassembleSSE(text) {
  const lines = text.split("\n");
  let content = "";
  const toolCalls = /* @__PURE__ */ new Map();
  let finishReason = "stop";
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  for (const line of lines) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const chunk = JSON.parse(line.slice(6));
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) {
        if (chunk.usage) usage = chunk.usage;
        continue;
      }
      if (delta.content) content += delta.content;
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing = toolCalls.get(idx);
          if (!existing) {
            toolCalls.set(idx, { id: tc.id || "", name: tc.function?.name || "", args: tc.function?.arguments || "" });
          } else {
            if (tc.function?.arguments) existing.args += tc.function.arguments;
          }
        }
      }
      const item = chunk.item;
      if (item?.call_id) {
        let found = false;
        for (const [, tc] of toolCalls) {
          if (tc.id === item.call_id) {
            if (item.name) tc.name = item.name;
            if (item.arguments) tc.args = item.arguments;
            found = true;
            break;
          }
        }
        if (!found) {
          toolCalls.set(toolCalls.size, { id: item.call_id, name: item.name || "", args: item.arguments || "" });
        }
      }
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
    } catch {
    }
  }
  const reassembledToolCalls = [...toolCalls.values()].map((tc) => ({
    id: tc.id,
    function: { name: tc.name, arguments: tc.args }
  }));
  const hasToolCalls = reassembledToolCalls.length > 0;
  return {
    choices: [{ message: { content: content || null, tool_calls: hasToolCalls ? reassembledToolCalls : void 0 }, finish_reason: hasToolCalls ? "tool_calls" : finishReason }],
    usage
  };
}
function convertMessages2(messages) {
  return messages.map((m) => {
    if (m.role === "tool" && Array.isArray(m.content)) {
      const parts = m.content.map((c) => `[Tool result for ${c.toolCallId}]: ${c.content}`).join("\n");
      return { role: "user", content: parts };
    }
    return { role: m.role, content: m.content };
  }).flat();
}
function parseResponse2(data) {
  const choice = data.choices?.[0];
  if (!choice) {
    return { text: "", toolCalls: [], usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 }, stopReason: "end" };
  }
  const toolCalls = (choice.message?.tool_calls ?? []).map((tc) => {
    let input = {};
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {
    }
    return { id: tc.id, name: tc.function.name, input, arguments: tc.function.arguments || "" };
  });
  return {
    text: choice?.message.content ?? "",
    toolCalls,
    usage: { input: data.usage.prompt_tokens, output: data.usage.completion_tokens },
    stopReason: choice?.finish_reason === "tool_calls" ? "tool_use" : "end"
  };
}

// src/providers/provider.ts
function createProvider(config) {
  const provider = config.provider ?? detectProvider(config);
  switch (provider) {
    case "anthropic":
      return createAnthropicProvider(config);
    case "openai":
      return createOpenAIProvider(config);
    default:
      return createOpenAIProvider(config);
  }
}
function detectProvider(config) {
  if (config.baseUrl?.includes("anthropic")) return "anthropic";
  if (config.apiKey?.startsWith("sk-ant-")) return "anthropic";
  return "openai";
}

// src/tools/search.ts
var searchToolDef = {
  name: "web_search",
  description: "Search the web for current information. Use when the question requires up-to-date facts, news, or data.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" }
    },
    required: ["query"]
  }
};
async function executeSearch(input, config) {
  const query = String(input.query ?? "");
  if (!query) return { text: "No query provided", sources: [] };
  const provider = config?.provider ?? "tavily";
  if (provider === "tavily") {
    return searchTavily(query, config?.apiKey);
  }
  return searchSerper(query, config?.apiKey);
}
async function searchTavily(query, apiKey) {
  if (!apiKey) throw new Error("Search requires apiKey \u2014 set toolConfig.search.apiKey");
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: 5, include_answer: true, include_images: true })
  });
  if (!res.ok) throw new Error(`Tavily error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const sources = (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
  const images = (data.images ?? []).map((img) => typeof img === "string" ? img : img.url);
  const text = data.answer ?? sources.map((s) => `${s.title}: ${s.snippet}`).join("\n");
  return { text, sources, images };
}
async function searchSerper(query, apiKey) {
  if (!apiKey) throw new Error("Search requires apiKey \u2014 set toolConfig.search.apiKey");
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify({ q: query, num: 5 })
  });
  if (!res.ok) throw new Error(`Serper error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const sources = (data.organic ?? []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet }));
  const text = sources.map((s) => `${s.title}: ${s.snippet}`).join("\n");
  return { text, sources };
}

// src/tools/code.ts
var codeToolDef = {
  name: "code_exec",
  description: "Execute JavaScript code to perform calculations, data processing, or analysis. Returns the result of the last expression.",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "JavaScript code to execute" }
    },
    required: ["code"]
  }
};
async function executeCode(input, config) {
  const code = String(input.code ?? "");
  if (!code) return { code: "", output: "", error: "No code provided" };
  const timeout = config?.timeout ?? 5e3;
  try {
    const result = await runWithTimeout(code, timeout);
    return { code, output: String(result) };
  } catch (err) {
    return { code, output: "", error: String(err) };
  }
}
function runWithTimeout(code, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Code execution timed out (${timeoutMs}ms)`)), timeoutMs);
    try {
      const fn = new Function("console", `
        const logs = [];
        const _console = { log: (...a) => logs.push(a.map(String).join(' ')), error: (...a) => logs.push(a.map(String).join(' ')) };
        const result = (function() { ${code} })();
        return { result, logs };
      `);
      const { result, logs } = fn(console);
      clearTimeout(timer);
      const output = logs.length > 0 ? logs.join("\n") + (result !== void 0 ? "\n\u2192 " + String(result) : "") : String(result ?? "");
      resolve(output);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

// src/tools/file.ts
import { readFile, writeFile } from "fs/promises";
var fileReadToolDef = {
  name: "file_read",
  description: "Read the contents of a local file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read" }
    },
    required: ["path"]
  }
};
var fileWriteToolDef = {
  name: "file_write",
  description: "Write content to a local file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write" },
      content: { type: "string", description: "Content to write" }
    },
    required: ["path", "content"]
  }
};
async function executeFileRead(input) {
  const path = String(input.path ?? "");
  try {
    const content = await readFile(path, "utf-8");
    return { path, action: "read", content };
  } catch (err) {
    return { path, action: "read", content: `Error: ${err}` };
  }
}
async function executeFileWrite(input) {
  const path = String(input.path ?? "");
  const content = String(input.content ?? "");
  try {
    await writeFile(path, content, "utf-8");
    return { path, action: "write" };
  } catch (err) {
    return { path, action: "write", content: `Error: ${err}` };
  }
}

// src/ask.ts
var MAX_TOOL_ROUNDS = 10;
async function ask(prompt, config) {
  const provider = createProvider(config);
  const enabledTools = config.tools ?? ["search"];
  const toolDefs = buildToolDefs(enabledTools);
  const messages = [{ role: "user", content: prompt }];
  const allToolCalls = [];
  const allSources = [];
  const allCodeResults = [];
  const allFileResults = [];
  const allImages = [];
  let totalUsage = { input: 0, output: 0 };
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await provider.chat(messages, toolDefs);
    totalUsage.input += response.usage.input;
    totalUsage.output += response.usage.output;
    if (response.stopReason !== "tool_use" || response.toolCalls.length === 0) {
      return {
        answer: response.text,
        sources: allSources.length > 0 ? allSources : void 0,
        images: allImages.length > 0 ? allImages : void 0,
        codeResults: allCodeResults.length > 0 ? allCodeResults : void 0,
        files: allFileResults.length > 0 ? allFileResults : void 0,
        toolCalls: allToolCalls.length > 0 ? allToolCalls : void 0,
        usage: totalUsage
      };
    }
    const toolResults = await executeToolCalls(response.toolCalls, config, {
      allSources,
      allCodeResults,
      allFileResults,
      allToolCalls,
      allImages
    });
    const callSummary = response.toolCalls.map(
      (tc) => `I called ${tc.name}(${JSON.stringify(tc.input)})`
    ).join("\n");
    const resultSummary = toolResults.map((r) => r.content).join("\n");
    const assistantText = [response.text, callSummary].filter(Boolean).join("\n");
    messages.push({ role: "assistant", content: assistantText });
    messages.push({ role: "user", content: `Here are the tool results:
${resultSummary}

Please provide the final answer based on these results.` });
    const finalResponse = await provider.chat(messages, []);
    totalUsage.input += finalResponse.usage.input;
    totalUsage.output += finalResponse.usage.output;
    return {
      answer: finalResponse.text,
      sources: allSources.length > 0 ? allSources : void 0,
      codeResults: allCodeResults.length > 0 ? allCodeResults : void 0,
      files: allFileResults.length > 0 ? allFileResults : void 0,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : void 0,
      usage: totalUsage
    };
  }
  throw new Error(`Agent loop exceeded ${MAX_TOOL_ROUNDS} rounds`);
}
async function executeToolCalls(toolCalls, config, acc) {
  const results = [];
  for (const tc of toolCalls) {
    const output = await executeSingleTool(tc, config, acc);
    acc.allToolCalls.push({ tool: tc.name, input: tc.input, output });
    results.push({ type: "tool_result", toolCallId: tc.id, content: String(output) });
  }
  return results;
}
async function executeSingleTool(tc, config, acc) {
  switch (tc.name) {
    case "web_search": {
      const result = await executeSearch(tc.input, config.toolConfig?.search);
      acc.allSources.push(...result.sources);
      if (result.images) acc.allImages.push(...result.images);
      return result.text;
    }
    case "code_exec": {
      const result = await executeCode(tc.input, config.toolConfig?.code);
      acc.allCodeResults.push(result);
      return result.error ? `Error: ${result.error}` : result.output;
    }
    case "file_read": {
      const result = await executeFileRead(tc.input);
      acc.allFileResults.push(result);
      return result.content ?? "File read complete";
    }
    case "file_write": {
      const result = await executeFileWrite(tc.input);
      acc.allFileResults.push(result);
      return result.content ?? "File written";
    }
    default:
      return `Unknown tool: ${tc.name}`;
  }
}
function buildToolDefs(tools) {
  const defs = [];
  if (tools.includes("search")) defs.push(searchToolDef);
  if (tools.includes("code")) defs.push(codeToolDef);
  if (tools.includes("file")) {
    defs.push(fileReadToolDef);
    defs.push(fileWriteToolDef);
  }
  return defs;
}
export {
  ask,
  createProvider
};
