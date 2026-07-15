import { basename } from 'node:path'

interface AgentsFilesResult {
  agentsFiles: Array<{ path: string; content: string }>
}

// Pi runtime 不应加载 Claude SDK 专属的 CLAUDE.md 文件作为 agent 上下文。
// 如果 Claude SDK 将来更改文件名，或 Pi 引入类似文件，需同步更新此过滤集。
const LEGACY_AGENT_CONTEXT_FILE_NAMES = new Set(['claude.md'])

export function createPromaAgentsFilesOverride(): (base: AgentsFilesResult) => AgentsFilesResult {
  return (base) => ({
    agentsFiles: base.agentsFiles.filter((file) => !LEGACY_AGENT_CONTEXT_FILE_NAMES.has(basename(file.path).toLowerCase())),
  })
}
