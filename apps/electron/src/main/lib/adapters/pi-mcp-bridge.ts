/**
 * Pi Runtime MCP 服务器桥接层
 *
 * 将用户配置的外部 MCP 服务器（stdio / http / sse）桥接到 Pi 的 customTools。
 *
 * Pi SDK 的 createAgentSession 不支持 mcpServers 参数，因此这里自己维护 MCP client，
 * 在工具列表中列出 tools，把每个 tool 包装成 sdk.defineTool() 注册。
 *
 * 生命周期与 PiAgentAdapter.query() 绑定：query 开始时建立连接，结束时 cleanup 关闭。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { McpTransportType, McpServerEntry } from '@proma/shared'
import { normalizeMcpTransportType } from '@proma/shared'
import { Type } from 'typebox'

// ===== MCP JSON-RPC 类型 =====

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface McpToolSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean'
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

interface McpTool {
  name: string
  description?: string
  inputSchema?: McpToolSchema
}

// ===== MCP Client =====

interface McpClient {
  name: string
  tools: McpTool[]
  /** 调用工具 */
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown>
  /** 关闭连接 */
  close: () => void
}

let rpcIdCounter = 0

function nextRpcId(): number {
  return ++rpcIdCounter
}

async function sendStdioRequest(
  process: ChildProcess,
  method: string,
  params?: unknown,
  timeoutMs = 30_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextRpcId()
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }

    const timer = setTimeout(() => {
      reject(new Error(`MCP stdio 请求超时 (${method}): ${id}`))
    }, timeoutMs)

    const onData = (data: Buffer): void => {
      const text = data.toString('utf-8').trim()
      // 逐行解析 JSON-RPC 响应
      const lines = text.split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const response = JSON.parse(line) as JsonRpcResponse
          if (response.id === id) {
            cleanup()
            if (response.error) {
              reject(new Error(`MCP 错误 (${response.error.code}): ${response.error.message}`))
            } else {
              resolve(response.result)
            }
            return
          }
        } catch {
          // 非 JSON 行（如日志输出）忽略
        }
      }
    }

    process.stdout?.on('data', onData)
    process.stderr?.on('data', () => {}) // 消费 stderr 避免背压

    const cleanup = (): void => {
      clearTimeout(timer)
      process.stdout?.removeListener('data', onData)
    }

    process.stdin?.write(JSON.stringify(request) + '\n')
  })
}

async function sendHttpRequest(
  url: string,
  method: string,
  params?: unknown,
  headers?: Record<string, string>,
  timeoutMs = 30_000,
): Promise<unknown> {
  const id = nextRpcId()
  const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`MCP HTTP 请求失败: ${response.status} ${response.statusText}`)
    }

    const result = (await response.json()) as JsonRpcResponse
    if (result.error) {
      throw new Error(`MCP 错误 (${result.error.code}): ${result.error.message}`)
    }
    return result.result
  } finally {
    clearTimeout(timer)
  }
}

/** 创建 stdio MCP client */
async function createStdioMcpClient(
  name: string,
  entry: McpServerEntry,
): Promise<McpClient> {
  const child = spawn(entry.command!, entry.args ?? [], {
    env: { ...process.env, ...entry.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const childRef = { current: child }

  // 消费 stderr（MCP 服务器可能输出日志到 stderr）
  child.stderr?.on('data', () => {})

  // 初始化握手
  await sendStdioRequest(child, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    clientInfo: { name: 'proma-pi', version: '1.0.0' },
  }, (entry.timeout ?? 30) * 1000)

  // 列出工具
  const toolsResult = await sendStdioRequest(child, 'tools/list', undefined, 10_000) as { tools?: McpTool[] }
  const tools = toolsResult?.tools ?? []

  return {
    name,
    tools,
    async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
      return sendStdioRequest(childRef.current, 'tools/call', {
        name: toolName,
        arguments: args,
      })
    },
    close() {
      if (!childRef.current.killed) {
        childRef.current.kill('SIGTERM')
        // 5s 后强制 kill
        setTimeout(() => {
          if (!childRef.current.killed) childRef.current.kill('SIGKILL')
        }, 5000)
      }
    },
  }
}

/** 创建 HTTP/SSE MCP client（HTTP 模式走 POST JSON-RPC） */
async function createHttpMcpClient(
  name: string,
  entry: McpServerEntry,
): Promise<McpClient> {
  const url = entry.url!
  const headers = entry.headers

  // 初始化握手
  await sendHttpRequest(url, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    clientInfo: { name: 'proma-pi', version: '1.0.0' },
  }, headers, (entry.timeout ?? 30) * 1000)

  // 列出工具
  const toolsResult = await sendHttpRequest(url, 'tools/list', undefined, headers, 10_000) as { tools?: McpTool[] }
  const tools = toolsResult?.tools ?? []

  return {
    name,
    tools,
    async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
      return sendHttpRequest(url, 'tools/call', { name: toolName, arguments: args }, headers)
    },
    close() {
      // HTTP client 无状态，无需关闭
    },
  }
}

/** 创建一个 Pi ToolDefinition 的通用回调内容 */
function mcpToolResultToText(result: unknown): string {
  if (result === null || result === undefined) return '（无返回）'
  if (typeof result === 'string') return result
  if (typeof result === 'object') {
    const content = (result as Record<string, unknown>)?.content
    if (Array.isArray(content)) {
      return content
        .map((block: Record<string, unknown>) => {
          if (block.type === 'text') return String(block.text ?? '')
          if (block.type === 'resource') return JSON.stringify(block.resource ?? block)
          return JSON.stringify(block)
        })
        .filter(Boolean)
        .join('\n')
    }
    return JSON.stringify(result, null, 2)
  }
  return String(result)
}

// ===== TypeBox 转换 =====

function jsonSchemaToTypeBox(
  schema: McpToolSchema | undefined,
): ReturnType<typeof Type.Object> {
  if (!schema || !schema.properties || Object.keys(schema.properties).length === 0) {
    return Type.Object({})
  }

  const properties: Record<string, ReturnType<typeof Type.Object>> = {}
  for (const [key, prop] of Object.entries(schema.properties)) {
    const propSchema = prop as Record<string, unknown>
    const isRequired = Array.isArray(schema.required) && schema.required.includes(key)
    let tbType: ReturnType<typeof Type.Any>

    switch (propSchema.type) {
      case 'string':
        tbType = propSchema.enum
          ? Type.Union((propSchema.enum as string[]).map((v: string) => Type.Literal(v))) as ReturnType<typeof Type.Any>
          : Type.String() as ReturnType<typeof Type.Any>
        break
      case 'number':
        tbType = Type.Number() as ReturnType<typeof Type.Any>
        break
      case 'integer':
        tbType = Type.Integer() as ReturnType<typeof Type.Any>
        break
      case 'boolean':
        tbType = Type.Boolean() as ReturnType<typeof Type.Any>
        break
      case 'array':
        tbType = Type.Array(Type.Any()) as ReturnType<typeof Type.Any>
        break
      case 'object':
        tbType = Type.Record(Type.String(), Type.Any()) as ReturnType<typeof Type.Any>
        break
      default:
        tbType = Type.Any() as ReturnType<typeof Type.Any>
    }

    properties[key] = isRequired ? tbType : Type.Optional(tbType as never) as ReturnType<typeof Type.Any>
  }

  return Type.Object(properties)
}

// ===== 模块级缓存：MCP client 池 =====

const mcpClients = new Map<string, McpClient>()
const mcpClientRefCount = new Map<string, number>()

/**
 * 为 PiAgentAdapter.query() 构建 MCP customTools。
 *
 * 在 query() 开始时调用，建立 MCP 连接并列出工具；
 * 在 cleanupActiveSession 中调用 cleanupMcpClients() 断开连接。
 */
export async function buildMcpCustomTools(
  sdk: typeof import('@earendil-works/pi-coding-agent'),
  mcpServers: Record<string, McpServerEntry>,
): Promise<{ tools: unknown[]; cleanup: () => void }> {
  const tools: unknown[] = []
  const connectedClients: McpClient[] = []

  for (const [name, entry] of Object.entries(mcpServers)) {
    if (!entry.enabled) continue
    const type = normalizeMcpTransportType(entry.type)
    if (!type) {
      console.warn(`[Pi MCP 桥接] 服务器 "${name}" 传输类型未知，已跳过`)
      continue
    }

    try {
      // 复用已有连接（同一 session 可能多次 query）
      const existing = mcpClients.get(name)
      if (existing) {
        mcpClientRefCount.set(name, (mcpClientRefCount.get(name) ?? 0) + 1)
        connectedClients.push(existing)
        tools.push(...convertMcpToolsToPiTools(sdk, name, existing.tools, existing))
        console.log(`[Pi MCP 桥接] 复用已有 MCP 连接: ${name} (${existing.tools.length} 个工具)`)
        continue
      }

      let client: McpClient
      if (type === 'stdio') {
        client = await createStdioMcpClient(name, entry)
      } else if (type === 'http' || type === 'sse') {
        client = await createHttpMcpClient(name, entry)
      } else {
        console.warn(`[Pi MCP 桥接] 服务器 "${name}" 传输类型不受支持: ${type}`)
        continue
      }

      mcpClients.set(name, client)
      mcpClientRefCount.set(name, 1)
      connectedClients.push(client)
      tools.push(...convertMcpToolsToPiTools(sdk, name, client.tools, client))
      console.log(`[Pi MCP 桥接] 已连接 MCP 服务器: ${name} (${client.tools.length} 个工具)`)
    } catch (error) {
      console.warn(`[Pi MCP 桥接] 连接 MCP 服务器 "${name}" 失败:`, error)
      // 单个服务器失败不影响其他
    }
  }

  return {
    tools,
    cleanup() {
      for (const client of connectedClients) {
        const refCount = mcpClientRefCount.get(client.name) ?? 1
        if (refCount <= 1) {
          client.close()
          mcpClients.delete(client.name)
          mcpClientRefCount.delete(client.name)
        } else {
          mcpClientRefCount.set(client.name, refCount - 1)
        }
      }
    },
  }
}

function convertMcpToolsToPiTools(
  sdk: typeof import('@earendil-works/pi-coding-agent'),
  serverName: string,
  mcpTools: McpTool[],
  client: McpClient,
): unknown[] {
  return mcpTools.map((mcpTool) => {
    const toolName = `mcp__${serverName}__${mcpTool.name}`
    return sdk.defineTool({
      name: toolName,
      label: `${serverName}: ${mcpTool.name}`,
      description: mcpTool.description ?? `MCP 工具 (${serverName}.${mcpTool.name})`,
      parameters: jsonSchemaToTypeBox(mcpTool.inputSchema),
      async execute(
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: unknown,
        _ctx?: unknown,
      ): Promise<unknown> {
        const result = await client.callTool(mcpTool.name, (params ?? {}) as Record<string, unknown>)
        return {
          content: [{ type: 'text' as const, text: mcpToolResultToText(result) }],
        }
      },
    })
  })
}