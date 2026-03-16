// loop-detection.js - 智能循环检测（对齐 OpenClaw）
// 使用浏览器 SubtleCrypto API

const WARNING_THRESHOLD = 10
const CRITICAL_THRESHOLD = 20
const GLOBAL_CIRCUIT_BREAKER_THRESHOLD = 30
const TOOL_CALL_HISTORY_SIZE = 30

async function hashString(str) {
  const encoder = new TextEncoder()
  const data = encoder.encode(str)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

function hashToolCall(toolName, params) {
  const serialized = JSON.stringify(params, Object.keys(params).sort())
  // 同步版本：用简单的字符串哈希代替
  let hash = 0
  for (let i = 0; i < serialized.length; i++) {
    const char = serialized.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return `${toolName}:${Math.abs(hash).toString(16)}`
}

function hashToolOutcome(toolName, params, result, error) {
  if (error) {
    const errorStr = String(error)
    let hash = 0
    for (let i = 0; i < errorStr.length; i++) {
      const char = errorStr.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return `error:${Math.abs(hash).toString(16)}`
  }
  
  let text = ''
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    text = result.content
      .filter(e => e.type === 'text')
      .map(e => e.text)
      .join('\n')
      .trim()
  }
  
  const outcome = JSON.stringify({ text, details: result?.details || {} })
  let hash = 0
  for (let i = 0; i < outcome.length; i++) {
    const char = outcome.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(16)
}

function getNoProgressStreak(history, toolName, argsHash) {
  let streak = 0
  let latestResultHash = undefined
  
  for (let i = history.length - 1; i >= 0; i--) {
    const record = history[i]
    if (!record || record.toolName !== toolName || record.argsHash !== argsHash) continue
    if (!record.resultHash) continue
    
    if (!latestResultHash) {
      latestResultHash = record.resultHash
      streak = 1
      continue
    }
    
    if (record.resultHash !== latestResultHash) break
    streak++
  }
  
  return { count: streak, latestResultHash }
}

function getPingPongStreak(history, currentHash) {
  const last = history[history.length - 1]
  if (!last) return { count: 0, noProgressEvidence: false }
  
  let otherHash = undefined
  let otherToolName = undefined
  for (let i = history.length - 2; i >= 0; i--) {
    const call = history[i]
    if (!call || call.argsHash === last.argsHash) continue
    otherHash = call.argsHash
    otherToolName = call.toolName
    break
  }
  
  if (!otherHash || !otherToolName) return { count: 0, noProgressEvidence: false }
  
  let alternatingCount = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const call = history[i]
    if (!call) continue
    const expected = alternatingCount % 2 === 0 ? last.argsHash : otherHash
    if (call.argsHash !== expected) break
    alternatingCount++
  }
  
  if (alternatingCount < 2 || currentHash !== otherHash) {
    return { count: 0, noProgressEvidence: false }
  }
  
  // 检查是否有进展
  let firstHashA = undefined
  let firstHashB = undefined
  let noProgressEvidence = true
  
  const tailStart = Math.max(0, history.length - alternatingCount)
  for (let i = tailStart; i < history.length; i++) {
    const call = history[i]
    if (!call || !call.resultHash) {
      noProgressEvidence = false
      break
    }
    
    if (call.argsHash === last.argsHash) {
      if (!firstHashA) firstHashA = call.resultHash
      else if (firstHashA !== call.resultHash) noProgressEvidence = false
    } else if (call.argsHash === otherHash) {
      if (!firstHashB) firstHashB = call.resultHash
      else if (firstHashB !== call.resultHash) noProgressEvidence = false
    }
  }
  
  if (!firstHashA || !firstHashB) noProgressEvidence = false
  
  return {
    count: alternatingCount + 1,
    pairedToolName: last.toolName,
    pairedHash: last.argsHash,
    noProgressEvidence
  }
}

export function detectToolCallLoop(state, toolName, params) {
  const history = state.toolCallHistory || []
  const currentHash = hashToolCall(toolName, params)
  
  const noProgress = getNoProgressStreak(history, toolName, currentHash)
  const noProgressStreak = noProgress.count
  
  // 全局熔断
  if (noProgressStreak >= GLOBAL_CIRCUIT_BREAKER_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'global_circuit_breaker',
      count: noProgressStreak,
      message: `CRITICAL: ${toolName} repeated ${noProgressStreak} times with no progress. Execution blocked.`
    }
  }
  
  // 轮询工具检测
  const isKnownPoll = toolName === 'command_status' || 
    (toolName === 'process' && params.action === 'poll')
  
  if (isKnownPoll && noProgressStreak >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'known_poll_no_progress',
      count: noProgressStreak,
      message: `CRITICAL: Polling loop detected. Called ${toolName} ${noProgressStreak} times with no progress.`
    }
  }
  
  if (isKnownPoll && noProgressStreak >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'known_poll_no_progress',
      count: noProgressStreak,
      message: `WARNING: Polling loop warning. Called ${toolName} ${noProgressStreak} times with no progress.`
    }
  }
  
  // 乒乓循环检测
  const pingPong = getPingPongStreak(history, currentHash)
  
  if (pingPong.count >= CRITICAL_THRESHOLD && pingPong.noProgressEvidence) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'ping_pong',
      count: pingPong.count,
      message: `CRITICAL: Ping-pong loop detected (${pingPong.count} alternating calls). Execution blocked.`,
      pairedToolName: pingPong.pairedToolName
    }
  }
  
  if (pingPong.count >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'ping_pong',
      count: pingPong.count,
      message: `WARNING: Ping-pong loop warning (${pingPong.count} alternating calls).`,
      pairedToolName: pingPong.pairedToolName
    }
  }
  
  // 通用重复检测
  const recentCount = history.filter(
    h => h.toolName === toolName && h.argsHash === currentHash
  ).length
  
  if (!isKnownPoll && recentCount >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'generic_repeat',
      count: recentCount,
      message: `WARNING: ${toolName} called ${recentCount} times with identical arguments.`
    }
  }
  
  return { stuck: false }
}

export function recordToolCall(state, toolName, params) {
  if (!state.toolCallHistory) state.toolCallHistory = []
  
  state.toolCallHistory.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    timestamp: Date.now()
  })
  
  if (state.toolCallHistory.length > TOOL_CALL_HISTORY_SIZE) {
    state.toolCallHistory.shift()
  }
}

export function recordToolCallOutcome(state, toolName, params, result, error) {
  if (!state.toolCallHistory) state.toolCallHistory = []
  
  const argsHash = hashToolCall(toolName, params)
  const resultHash = hashToolOutcome(toolName, params, result, error)
  
  // 找最后一条匹配的记录并更新
  for (let i = state.toolCallHistory.length - 1; i >= 0; i--) {
    const call = state.toolCallHistory[i]
    if (call.toolName === toolName && call.argsHash === argsHash && !call.resultHash) {
      call.resultHash = resultHash
      return
    }
  }
  
  // 如果没找到，新增
  state.toolCallHistory.push({
    toolName,
    argsHash,
    resultHash,
    timestamp: Date.now()
  })
  
  if (state.toolCallHistory.length > TOOL_CALL_HISTORY_SIZE) {
    state.toolCallHistory.shift()
  }
}
