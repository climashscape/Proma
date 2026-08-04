/**
 * Git Diff 服务
 *
 * 提供工作区文件变更检测、diff 获取、文件还原等 Git 操作。
 * 使用异步 spawn 模式，避免阻塞主进程。
 */

import { spawn } from 'child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'
import type { ChangedFileEntry, UnstagedChangesResult, UntrackedFileEntry } from '@proma/shared'
import { normalizePathForCompare } from '@proma/shared'
import type { ChangeSource, ChangedFileStatus } from '@proma/shared'

/** 大文件读取上限：超过则跳过，避免 IPC 序列化撑爆内存 */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024

/** listRepos 结果缓存 TTL：仓库列表相对稳定，避免每次打开下拉都全量扫 git */
const LIST_REPOS_CACHE_TTL_MS = 60_000
const listReposCache = new Map<string, { ts: number; repos: import('@proma/shared').RepoInfo[] }>()

/**
 * 全量变更扫描并发上限。
 *
 * 在包含大量独立 Git 仓库的项目根（如 monorepo、fork 集合目录）下，
 * 一次 getUnstagedChanges 会为每个仓库 spawn git 进程；并发过多会让
 * 磁盘 IO 和 CPU 同时被打满，反而比串行更慢（Windows 上尤其明显）。
 * 限制并发可摊平峰值，又不牺牲整体吞吐。
 */
const MAX_CONCURRENT_GIT_ROOTS = 6

/**
 * 变更扫描结果缓存 TTL（ms）：窗口聚焦、写文件完成等高频触发在窗口内复用结果，避免重复全量 git 扫描。
 * 5s 权衡：冷扫描约 10s+（大型目录），TTL 过短会导致频繁失效重扫；写文件/git 变更/revert 后
 * 都会通过 invalidateGitDiffCache() 主动失效，保证最新结果立即可见，所以 TTL 可相对宽松。
 */
const SCAN_CACHE_TTL_MS = 5000

/** 向下递归搜索 git 根时，单目录条目数上限：超过视为超大/高噪声目录，跳过深入 */
const MAX_DIR_ENTRIES_FOR_DOWNSCAN = 5000

/**
 * 变更扫描结果缓存。key 由 dirPath/sessionPath/workspaceFilesPath/extraPaths 组合而成；
 * TTL 内命中直接返回，避免窗口聚焦等高频率、结果通常未变的场景反复触发全量 git 命令。
 * agent 写文件 / git 变更完成后通过 invalidateGitDiffCache() 主动失效，保证最新结果立即可见。
 */
interface ScanCacheEntry {
  result: UnstagedChangesResult
  /** 该条目覆盖的 git 仓库根（完整路径），用于定向失效 */
  gitRoots: string[]
  /** 写入时的缓存代际；invalidate 后递增，代际不符的写入丢弃（防 in-flight 扫描回写旧结果） */
  generation: number
  expiresAt: number
}
const scanCache = new Map<string, ScanCacheEntry>()

/**
 * 缓存代际：每次 invalidateGitDiffCache 递增。
 * in-flight 的 getUnstagedChanges 在失效之后完成时，setCached* 会检测到
 * 代际不符而丢弃写入，避免把失效前启动的旧扫描结果回填到缓存。
 */
let cacheGeneration = 0

function bumpCacheGeneration(): void {
  cacheGeneration++
}

/**
 * 仓库级扫描结果缓存：gitRoot → 该仓库的变更结果。
 * 与整批 scanCache 配合：写文件后定向失效只删受影响仓库的条目，
 * 下次 getUnstagedChanges 时其他仓库命中缓存，仅重扫受影响仓库，
 * 避免 Agent 连续写文件时每次全量重扫 31 个仓库（CPU 飙升主因）。
 */
interface PerRepoCacheEntry {
  files: ChangedFileEntry[]
  untracked: UntrackedFileEntry[]
  /** 写入时的缓存代际；代际不符的写入丢弃 */
  generation: number
  expiresAt: number
}
const perRepoCache = new Map<string, PerRepoCacheEntry>()
const PER_REPO_CACHE_TTL_MS = 5000

/** 读取未过期的仓库级缓存（代际不符视为失效） */
function getCachedPerRepo(gitRoot: string): { files: ChangedFileEntry[]; untracked: UntrackedFileEntry[] } | null {
  const entry = perRepoCache.get(gitRoot)
  if (!entry) return null
  if (entry.generation !== cacheGeneration) {
    perRepoCache.delete(gitRoot)
    return null
  }
  if (Date.now() >= entry.expiresAt) {
    perRepoCache.delete(gitRoot)
    return null
  }
  return { files: entry.files, untracked: entry.untracked }
}

/** 写入仓库级缓存（代际不符时丢弃，防 in-flight 旧结果回填） */
function setCachedPerRepo(
  gitRoot: string,
  files: ChangedFileEntry[],
  untracked: UntrackedFileEntry[],
): void {
  perRepoCache.set(gitRoot, { files, untracked, generation: cacheGeneration, expiresAt: Date.now() + PER_REPO_CACHE_TTL_MS })
  if (perRepoCache.size > 128) {
    const oldest = perRepoCache.keys().next().value
    if (oldest !== undefined) perRepoCache.delete(oldest)
  }
}

/** 仓库根发现结果缓存 TTL（ms）：仓库结构比变更结果稳定，但新 clone/新建 worktree 应尽快被发现，取 10s 平衡 */
const GIT_ROOTS_CACHE_TTL_MS = 10000

interface GitRootsCacheEntry {
  roots: string[]
  expiresAt: number
}
const gitRootsCache = new Map<string, GitRootsCacheEntry>()

/**
 * 仓库根发现缓存 key：向上搜索是否跳过会影响结果（skipUpward 时不含向上命中），
 * 故 key 需区分，避免 listRepos（skipUpward）与 getUnstagedChanges 之间串缓存。
 */
function gitRootsCacheKey(baseDir: string, skipUpward?: boolean): string {
  return skipUpward ? `${baseDir}#down` : baseDir
}

/** 读取未过期的仓库根发现缓存 */
function getCachedGitRoots(cacheKey: string): string[] | null {
  const entry = gitRootsCache.get(cacheKey)
  if (!entry) return null
  if (Date.now() >= entry.expiresAt) {
    gitRootsCache.delete(cacheKey)
    return null
  }
  return entry.roots
}

/** 写入仓库根发现缓存（随变更扫描缓存一并清理） */
function setCachedGitRoots(cacheKey: string, roots: string[]): void {
  gitRootsCache.set(cacheKey, { roots, expiresAt: Date.now() + GIT_ROOTS_CACHE_TTL_MS })
  if (gitRootsCache.size > 64) {
    const oldest = gitRootsCache.keys().next().value
    if (oldest !== undefined) gitRootsCache.delete(oldest)
  }
}

/**
 * 使变更扫描缓存失效。
 *
 * 传 writtenPath 时只失效覆盖该路径的条目（Agent 连续写文件场景下避免每次都全量失效→全量重扫）；
 * 不传则全量失效（git 突变 / revert 等影响面不确定的操作）。
 *
 * 相对路径匹配策略：先做宽松匹配（repo 根相对路径，如 apps/electron/...），
 * 若相对路径未命中任何仓库（无法确定归属），则降级为全量失效——宁可重扫也不漏。
 */
export function invalidateGitDiffCache(writtenPath?: string): void {
  if (!writtenPath) {
    bumpCacheGeneration()
    scanCache.clear()
    perRepoCache.clear()
    gitRootsCache.clear()
    worktreesCache.clear()
    repoChangesCache.clear()
    listReposCache.clear()
    baseBranchCache.clear()
    return
  }

  const raw = writtenPath.replace(/\\/g, '/')
  const isAbsolute = raw.startsWith('/') || /^[A-Za-z]:/.test(raw)
  const affectedGitRoots: string[] = []

  // 1. 仓库级缓存：删除受影响仓库的条目（绝对路径时直接匹配；相对路径用仓库名前缀宽松匹配）
  for (const gitRoot of perRepoCache.keys()) {
    const rootNorm = normalizeCachePath(gitRoot)
    let hit = false
    if (isAbsolute) {
      const normalized = normalizeCachePath(raw)
      hit = normalized === rootNorm || normalized.startsWith(rootNorm + '/')
    } else {
      const rootBase = basename(rootNorm)
      // 宽松匹配：raw 以仓库名开头（Proma/...）或本身就是仓库内路径片段（apps/electron/...）
      hit = raw === rootBase || raw.startsWith(rootBase + '/')
    }
    if (hit) {
      perRepoCache.delete(gitRoot)
      affectedGitRoots.push(gitRoot)
    }
  }

  // 2. 整批缓存：删除覆盖受影响仓库的条目。
  //    绝对路径时直接对 scanCache 条目自身记录的 gitRoots 匹配（不依赖 perRepoCache 是否存在）；
  //    相对路径依赖 perRepoCache 命中，未命中时降级为全量失效。
  let clearedScan = false
  if (isAbsolute) {
    const normalized = normalizeCachePath(raw)
    for (const [key, entry] of scanCache) {
      const overlaps = entry.gitRoots.some((root) => {
        const rootNorm = normalizeCachePath(root)
        return normalized === rootNorm || normalized.startsWith(rootNorm + '/')
      })
      if (overlaps) {
        scanCache.delete(key)
        clearedScan = true
      }
    }
    // 绝对路径未命中任何缓存条目：可能是大小写不一致 / junction 真实路径差异，
    // 无法确定归属，降级为全量失效（宁可重扫不可漏）。
    if (!clearedScan) {
      scanCache.clear()
      perRepoCache.clear()
    }
  } else if (affectedGitRoots.length > 0) {
    const affectedNorms = affectedGitRoots.map(normalizeCachePath)
    for (const [key, entry] of scanCache) {
      const overlaps = entry.gitRoots.some((root) => affectedNorms.includes(normalizeCachePath(root)))
      if (overlaps) scanCache.delete(key)
    }
  } else {
    // 相对路径未命中任何仓库：无法确定归属，降级为全量失效（宁可重扫不可漏）
    scanCache.clear()
    perRepoCache.clear()
  }

  // 定向失效也清理 repoChangesCache 中受影响仓库的条目（key 前缀含仓库根），
  // 否则 Agent 写文件后仓库聚合视图仍吃到 5s TTL 内的旧数据。
  if (affectedGitRoots.length > 0) {
    for (const key of repoChangesCache.keys()) {
      const affected = affectedGitRoots.some((root) =>
        key.includes(`repo:${normalizeGitRoot(root)}:`) || key.includes(`repo:${normalizeGitRoot(root)}|`),
      )
      if (affected) repoChangesCache.delete(key)
    }
  }

  // 无论定向还是全量，都递增代际：in-flight 扫描在失效后完成的 setCached* 将被丢弃
  bumpCacheGeneration()
}

/** 归一化路径用于缓存 key：统一分隔符（/ 与 \）并去除尾分隔符，避免同目录不同写法产生多份缓存 */
function normalizeCachePath(p: string): string {
  try {
    return resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
  } catch {
    // 极端输入（含 NUL 等非法字符）下回退到原文，保证缓存 key 构造永不抛错
    return p
  }
}

/** 构建变更扫描缓存 key（规范化 extraPaths 顺序，避免同一集合不同排列造成缓存抖动） */
function buildScanCacheKey(
  dirPath: string,
  sessionPath?: string,
  workspaceFilesPath?: string,
  extraPaths?: string[],
): string {
  return JSON.stringify([
    normalizeCachePath(dirPath),
    sessionPath ? normalizeCachePath(sessionPath) : '',
    workspaceFilesPath ? normalizeCachePath(workspaceFilesPath) : '',
    [...(extraPaths ?? [])].map(normalizeCachePath).sort(),
  ])
}

/** 读取未过期缓存，命中则返回；过期或代际不符或未命中返回 null */
function getCachedScanResult(key: string): UnstagedChangesResult | null {
  const entry = scanCache.get(key)
  if (!entry) return null
  if (entry.generation !== cacheGeneration) {
    scanCache.delete(key)
    return null
  }
  if (Date.now() >= entry.expiresAt) {
    scanCache.delete(key)
    return null
  }
  return entry.result
}

/** 写入扫描结果缓存（代际不符时丢弃，防 in-flight 旧结果回填） */
function setCachedScanResult(key: string, result: UnstagedChangesResult, allGitRoots: string[]): void {
  // 记录该结果覆盖的 git 仓库根（完整路径），用于定向失效。
  // 即使结果为空（clean 仓库）也必须记录 gitRoots，否则写文件后定向失效
  // 无法命中该条目 → 整批缓存不删 → 新文件不显示。
  const gitRoots: string[] = []
  const pushRoot = (root?: string) => {
    if (root && !gitRoots.includes(root)) gitRoots.push(root)
  }
  result.files.forEach((f) => pushRoot(f.gitRoot))
  result.untrackedFiles.forEach((f) => pushRoot(f.gitRoot))
  allGitRoots.forEach((root) => pushRoot(root))

  scanCache.set(key, { result, gitRoots, generation: cacheGeneration, expiresAt: Date.now() + SCAN_CACHE_TTL_MS })
  // 防止缓存无限增长：超过 64 条时清理最早的一条
  if (scanCache.size > 64) {
    const oldest = scanCache.keys().next().value
    if (oldest !== undefined) scanCache.delete(oldest)
  }
}

/**
 * 有界并发执行器：最多同时运行 limit 个任务，结果按输入顺序返回。
 * 用于多个 git 仓库的变更扫描，控制同时 spawn 的 git 进程数量。
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0 || limit <= 0) return []

  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) break
      results[i] = await fn(items[i]!, i)
    }
  })
  await Promise.all(workers)
  return results
}




/**
 * 归一化换行符为 LF。
 *
 * diff 两侧内容来源不同：旧版本来自 `git show`（读对象库 blob，换行符为 LF），
 * 新版本来自磁盘工作区文件（Windows 在 core.autocrlf=true 下检出为 CRLF）。
 * 若不归一化，逐行 diff 会把每一行都判定为变更，导致整文件「全删全增」。
 * 此处只影响 diff 显示比较，不改写磁盘文件。
 */
function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n')
}

function normalizeComparablePath(filePath: string): string {
  return normalizePathForCompare(resolve(filePath))
}

interface ChangeCandidate {
  /** 原始候选路径，保留给 git root 搜索 */
  searchPath: string
  /** 用于过滤变更文件的规范化路径 */
  matchPath: string
  /** true 表示只匹配这个文件，false 表示匹配目录下所有文件 */
  fileOnly: boolean
}

function toChangeCandidate(input: string): ChangeCandidate | null {
  if (!input || typeof input !== 'string') return null
  const resolved = resolve(input)
  try {
    const stats = statSync(resolved)
    if (stats.isFile()) {
      return {
        searchPath: dirname(resolved),
        matchPath: normalizeComparablePath(resolved),
        fileOnly: true,
      }
    }
    if (stats.isDirectory()) {
      return {
        searchPath: resolved,
        matchPath: normalizeComparablePath(resolved),
        fileOnly: false,
      }
    }
  } catch {
    // 附加文件被删除后仍可能需要展示 git 删除记录；此时用父目录找仓库、按文件精确匹配。
    return {
      searchPath: dirname(resolved),
      matchPath: normalizeComparablePath(resolved),
      fileOnly: true,
    }
  }
  return null
}

/**
 * 校验并规范化 filePath，确保其位于 root 目录内。
 * 支持相对路径和绝对路径。绝对路径会被自动转为相对路径。
 * 拒绝 `..` 穿越和 root 外的路径。
 * 返回安全的相对路径，或 null 表示不安全。
 */
function normalizeSafePath(root: string, filePath: string): string | null {
  if (!filePath || typeof filePath !== 'string') return null
  let resolvedRoot: string
  try {
    resolvedRoot = realpathSync(resolve(root))
  } catch {
    resolvedRoot = resolve(root)
  }
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep

  if (isAbsolute(filePath)) {
    let resolvedFile: string
    try {
      resolvedFile = realpathSync(resolve(filePath))
    } catch {
      return null
    }
    if (!resolvedFile.startsWith(rootWithSep)) return null
    return resolvedFile.slice(rootWithSep.length)
  }

  if (filePath.includes('..')) return null
  const resolvedTarget = resolve(resolvedRoot, filePath)
  let realTarget: string
  try {
    realTarget = realpathSync(resolvedTarget)
  } catch {
    realTarget = resolvedTarget
  }
  if (!realTarget.startsWith(rootWithSep) && realTarget !== resolvedRoot) return null
  return filePath
}

/**
 * 异步执行 Git 命令
 *
 * @param args - Git 命令参数
 * @param cwd - 工作目录
 * @returns 命令输出，如果失败返回 null
 */
function runGitCommand(args: string[], cwd: string, options?: { quiet?: boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      // -c core.quotePath=false：禁用 git 对非 ASCII 路径的八进制转义（如中文文件名
      // 默认会输出为 "\347\250\213.md" 并加引号），保证 diff/ls-files 等输出原始 UTF-8 路径
      const child = spawn('git', ['-c', 'core.quotePath=false', ...args], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      })

      // 显式指定 UTF-8 编码：由 StringDecoder 正确处理跨 chunk 的多字节字符边界，
      // 避免中文文件名/内容在 chunk 切分处出现乱码（逐块 data.toString() 会损坏）
      child.stdout?.setEncoding('utf-8')
      child.stderr?.setEncoding('utf-8')

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data) => {
        stdout += data
      })

      child.stderr?.on('data', (data) => {
        stderr += data
      })

      // 10 秒超时
      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        console.warn('[git-diff-service] git 命令超时:', args.join(' '))
        resolve(null)
      }, 10000)

      child.on('close', (code) => {
        clearTimeout(timeout)
        if (code === 0) {
          resolve(stdout.trim())
        } else {
          if (!options?.quiet) {
            console.error('[git-diff-service] git 命令失败:', args.join(' '), stderr.trim())
          }
          resolve(null)
        }
      })

      child.on('error', (err) => {
        clearTimeout(timeout)
        if (!options?.quiet) {
          console.error('[git-diff-service] git 命令错误:', err)
        }
        resolve(null)
      })
    } catch {
      resolve(null)
    }
  })
}

/**
 * 计算文件的来源标识
 *
 * filePath 是相对于 gitRoot 的路径，需要拼成绝对路径后再和 session/workspace 路径比较
 */
function computeSource(
  filePath: string,
  gitRoot: string,
  sessionPath?: string,
  workspaceFilesPath?: string,
): ChangeSource {
  const absolutePath = join(gitRoot, filePath)
  let inSession = false
  let inWorkspace = false

  if (sessionPath) {
    const normalized = sessionPath.endsWith(sep) ? sessionPath : sessionPath + sep
    if (absolutePath.startsWith(normalized)) {
      inSession = true
    }
  }

  if (workspaceFilesPath) {
    const normalized = workspaceFilesPath.endsWith(sep) ? workspaceFilesPath : workspaceFilesPath + sep
    if (absolutePath.startsWith(normalized)) {
      inWorkspace = true
    }
  }

  if (inSession && inWorkspace) return 'both'
  if (inSession) return 'session'
  if (inWorkspace) return 'workspace'
  return 'none'
}

/**
 * 解析 numstat 输出为 path -> { additions, deletions } 映射。
 * 对 rename/copy 行（格式 `add\tdel\told => new` 或带 `{...}` 的），以新路径为 key。
 */
function parseNumstat(numStat: string | null): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>()
  if (!numStat) return map
  for (const line of numStat.split('\n')) {
    if (!line) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const additions = parseInt(parts[0]!, 10)
    const deletions = parseInt(parts[1]!, 10)
    let path = parts.slice(2).join('\t')
    // 处理 rename 格式 `old => new`
    const arrowIdx = path.indexOf(' => ')
    if (arrowIdx >= 0) {
      path = path.slice(arrowIdx + 4)
    }
    map.set(path, {
      additions: isNaN(additions) ? 0 : additions,
      deletions: isNaN(deletions) ? 0 : deletions,
    })
  }
  return map
}

/**
 * 按当前候选集过滤未过滤的仓库扫描结果（files/untracked），并计算 source。
 * perRepoCache 存未过滤原始结果（避免跨候选集污染），读取后统一用本函数裁剪。
 */
function filterRepoResult(
  rawFiles: ChangedFileEntry[],
  rawUntracked: UntrackedFileEntry[],
  gitRoot: string,
  isUnderAnyCandidate: (absPath: string) => boolean,
  sessionPath?: string,
  workspaceFilesPath?: string,
): { files: ChangedFileEntry[]; untracked: UntrackedFileEntry[] } {
  const files: ChangedFileEntry[] = []
  for (const f of rawFiles) {
    const absPath = join(gitRoot, f.filePath)
    if (!isUnderAnyCandidate(absPath)) continue
    files.push({
      ...f,
      source: computeSource(f.filePath, gitRoot, sessionPath, workspaceFilesPath),
    })
  }
  const untracked: UntrackedFileEntry[] = []
  for (const u of rawUntracked) {
    const absPath = join(gitRoot, u.filePath)
    if (!isUnderAnyCandidate(absPath)) continue
    untracked.push(u)
  }
  return { files, untracked }
}

/**
 * 获取当前工作树相对 HEAD 的文件变更列表（支持多 Git 仓库）
 *
 * 包含 staged + unstaged 改动；函数名保留为 getUnstagedChanges 以兼容现有 IPC。
 */
export async function getUnstagedChanges(
  dirPath: string,
  sessionPath?: string,
  workspaceFilesPath?: string,
  extraPaths?: string[],
): Promise<UnstagedChangesResult> {
  // 缓存：窗口聚焦、连续写文件等高频触发在 TTL 内直接复用上次结果，避免重复全量 git 扫描。
  // agent 写文件 / git 变更完成后通过 invalidateGitDiffCache() 主动失效，保证最新结果立即可见。
  const cacheKey = buildScanCacheKey(dirPath, sessionPath, workspaceFilesPath, extraPaths)
  const cached = getCachedScanResult(cacheKey)
  if (cached) return cached

  // 收集所有候选目录中的不重复 Git 仓库根
  const rawCandidates = [dirPath, sessionPath, workspaceFilesPath, ...(extraPaths || [])].filter(
    (p): p is string => typeof p === 'string' && p.length > 0
  )
  const candidates = rawCandidates
    .map(toChangeCandidate)
    .filter((candidate): candidate is ChangeCandidate => candidate !== null)

  const gitRoots: string[] = []
  for (const cand of candidates) {
    const roots = await findAllGitRoots(cand.searchPath)
    for (const root of roots) {
      if (!gitRoots.includes(root)) gitRoots.push(root)
      // 枚举该仓库的所有 worktree（非主 worktree 也纳入扫描），
      // 让默认「会话改动」视图也能看到 worktree 分支里的未提交改动。
      // worktree 列表走 10s 缓存，与 listRepos 共用，避免重复 spawn git。
      try {
        const wts = await listWorktreesFromRoot(root)
        for (const wt of wts) {
          if (wt.isMain) continue
          const wtRoot = normalizeGitRoot(wt.path)
          if (!gitRoots.includes(wtRoot)) gitRoots.push(wtRoot)
        }
      } catch {
        // worktree 枚举失败不影响主仓库扫描
      }
    }
  }

  if (gitRoots.length === 0) {
    const empty: UnstagedChangesResult = { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
    setCachedScanResult(cacheKey, empty, gitRoots)
    return empty
  }

  // 候选路径用于过滤：目录匹配子树，附加文件只匹配自身，避免显示同级无关改动。
  const isUnderAnyCandidate = (absPath: string): boolean => {
    const normalized = normalizeComparablePath(absPath)
    return candidates.some((candidate) => {
      if (candidate.fileOnly) return normalized === candidate.matchPath
      return normalized === candidate.matchPath || normalized.startsWith(candidate.matchPath + '/')
    })
  }

  // 扫描单个仓库：先读仓库级缓存（写文件定向失效后其他仓库仍命中），未命中才跑 git。
  // 先快速预检（git status --porcelain），工作树干净则直接跳过 3 条重命令。
  // 在 monorepo / fork 集合等大量仓库场景下，大多数仓库在大多数时刻是干净的，
  // 预检用 1 条轻量命令替代 3 条 diff/ls-files，可大幅降低总扫描耗时。
  //
  // 注意：perRepoCache 存的是**未按候选集过滤**的原始 git 结果（避免跨候选集污染），
  // 读取后统一用当前候选集过滤（filterRepoResult）。
  const scanGitRoot = async (gitRoot: string): Promise<{ files: ChangedFileEntry[]; untracked: UntrackedFileEntry[] }> => {
    // 仓库级缓存命中：Agent 写文件后只重扫受影响仓库，其余仓库直接复用原始结果再过滤
    const cachedRepo = getCachedPerRepo(gitRoot)
    if (cachedRepo) return filterRepoResult(cachedRepo.files, cachedRepo.untracked, gitRoot, isUnderAnyCandidate, sessionPath, workspaceFilesPath)

    // 快速预检：porcelain 输出为空表示无任何 staged/unstaged/untracked 变更。
    // 显式 --untracked-files=all：规避用户 git config status.showUntrackedFiles=no
    // 时 porcelain 不显示 untracked、与下方 ls-files --others 语义不一致的问题。
    // porcelain === null 表示 git 命令失败（瞬态错误），不缓存为空，避免隐藏真实变更。
    const porcelain = await runGitCommand(['status', '--porcelain', '--untracked-files=all'], gitRoot)
    if (porcelain === '') {
      setCachedPerRepo(gitRoot, [], [])
      return { files: [], untracked: [] }
    }
    if (porcelain === null) {
      return { files: [], untracked: [] }
    }

    // 有变更：并行执行 3 条 git 命令（name-status / numstat / ls-files）
    const [nameStatus, numStat, untrackedOutput] = await Promise.all([
      runGitCommand(['diff', 'HEAD', '--name-status'], gitRoot),
      runGitCommand(['diff', 'HEAD', '--numstat'], gitRoot),
      runGitCommand(['ls-files', '--others', '--exclude-standard'], gitRoot),
    ])
    const numStatMap = parseNumstat(numStat)

    // 未过滤的原始结果（不按候选集裁剪、不计算 source），供跨候选集复用
    const rawFiles: ChangedFileEntry[] = []
    if (nameStatus) {
      const statusLines = nameStatus.split('\n').filter(Boolean)

      for (const statusLine of statusLines) {
        const simpleMatch = statusLine.match(/^([MDAT])\t(.+)$/)
        const renameMatch = statusLine.match(/^([RC])\d*\t([^\t]+)\t(.+)$/)

        let status: ChangedFileStatus
        let filePath: string

        if (simpleMatch) {
          const code = simpleMatch[1]!
          status = code === 'D' ? 'deleted' : 'modified'
          filePath = simpleMatch[2]!
        } else if (renameMatch) {
          status = 'modified'
          filePath = renameMatch[3]!
        } else {
          continue
        }

        const stats = numStatMap.get(filePath) ?? { additions: 0, deletions: 0 }

        rawFiles.push({
          filePath,
          status,
          additions: stats.additions,
          deletions: stats.deletions,
          source: 'none',
          gitRoot,
        })
      }
    }

    // 获取未追踪文件（未过滤）
    const rawUntracked: UntrackedFileEntry[] = []
    if (untrackedOutput) {
      for (const rel of untrackedOutput.split('\n').filter(Boolean)) {
        rawUntracked.push({ filePath: rel, gitRoot })
      }
    }

    // porcelain 非空说明有变更，但若重命令全部失败（瞬态错误），不缓存空结果，避免 5s 内隐藏真实变更
    if (nameStatus === null && untrackedOutput === null && numStat === null) {
      return { files: [], untracked: [] }
    }

    setCachedPerRepo(gitRoot, rawFiles, rawUntracked)
    return filterRepoResult(rawFiles, rawUntracked, gitRoot, isUnderAnyCandidate, sessionPath, workspaceFilesPath)
  }

  // 多仓库并发扫描（有界并发，避免 git 进程风暴打满 CPU/磁盘）
  const scanned = await mapWithConcurrency(gitRoots, MAX_CONCURRENT_GIT_ROOTS, scanGitRoot)
  const allFiles = scanned.flatMap((r) => r.files)
  const allUntracked = scanned.flatMap((r) => r.untracked)

  const result: UnstagedChangesResult = {
    isGitRepo: true,
    files: allFiles,
    untrackedFiles: allUntracked,
    gitRootNames: gitRoots.map((r) => basename(r)),
  }
  setCachedScanResult(cacheKey, result, gitRoots)
  return result
}

/**
 * 归一化仓库根路径，用于去重。
 *
 * 两个数据源的分隔符风格不一致：`git rev-parse --show-toplevel` 在 Windows 返回正斜杠
 * （`C:/.../repo`），而 Node `path.join` 返回反斜杠（`C:\...\repo`）。统一用 resolve
 * 规范化并转为正斜杠，确保同一仓库的两种写法被识别为同一个根，避免重复跑 git diff。
 */
export function normalizeGitRoot(p: string): string {
  return resolve(p).replace(/\\/g, '/')
}

/** 向下递归搜索所有 .git 目录，返回所有找到的仓库根（不提前停止） */
function findAllGitRootsDown(dirPath: string, maxDepth: number): string[] {
  if (maxDepth <= 0) return []

  let entries: string[]
  try {
    entries = readdirSync(dirPath)
  } catch {
    return []
  }

  // 超大/高噪声目录保护：单层条目数超过上限时不深入递归子目录，避免缓存目录、生成产物等
  // 海量子目录拖慢扫描；但仍检查本层 .git 与直接子仓库，避免整棵子树（含兄弟仓库）被丢弃。
  const isHugeDir = entries.length > MAX_DIR_ENTRIES_FOR_DOWNSCAN

  const found: string[] = []
  for (const name of entries) {
    if (name === '.git') {
      // worktree 的 .git 是指针文件而非目录，不作为独立仓库根（由主仓库 worktree 枚举覆盖）
      try {
        const gitSt = statSync(join(dirPath, '.git'))
        if (gitSt.isDirectory()) found.push(dirPath)
      } catch {
        // ignore
      }
      continue
    }
    if (name.startsWith('.') || name === 'node_modules') continue

    const fullPath = join(dirPath, name)
    let st
    try { st = statSync(fullPath) } catch { continue }
    if (!st.isDirectory()) continue

    // 只有 .git 为目录才视为真仓库根；.git 为文件则是 worktree 指针（由主仓库枚举，跳过避免重复）
    let gitSt
    try { gitSt = statSync(join(fullPath, '.git')) } catch { gitSt = undefined }
    if (gitSt?.isDirectory()) {
      found.push(fullPath)
      // 已确认是 git root，不再深入避免重复
      continue
    }
    if (gitSt?.isFile()) {
      // worktree 目录：跳过深层递归（其内容属于同一仓库）
      continue
    }
    // 超大目录：跳过深层递归，但仍处理上面的直接子仓库检查
    if (isHugeDir) continue
    found.push(...findAllGitRootsDown(fullPath, maxDepth - 1))
  }

  return found
}

/** 查找 Git 仓库根目录（支持向上搜索子目录内的 repos），返回所有找到的根 */
export async function findAllGitRoots(baseDir: string, options?: { skipUpward?: boolean }): Promise<string[]> {
  if (!existsSync(baseDir)) return []

  // 仓库结构比变更结果稳定，缓存避免每次扫描重复冷启动 git rev-parse
  const cacheKey = gitRootsCacheKey(baseDir, options?.skipUpward)
  const cached = getCachedGitRoots(cacheKey)
  if (cached) return cached

  const roots: string[] = []

  // 1. 向上搜索：逐级 existsSync 找最近祖先 .git（目录或 worktree 文件，~1ms），
  //    避免 git rev-parse 冷启动（可达 3s+）；调用方已知 baseDir 非仓库时可跳过。
  if (!options?.skipUpward) {
    const topDir = findAncestorGitDir(baseDir)
    if (topDir) {
      const normalized = normalizeGitRoot(topDir)
      if (!roots.includes(normalized)) roots.push(normalized)
    }
  }

  // 2. 向下搜索所有子 .git
  for (const r of findAllGitRootsDown(baseDir, 3)) {
    const normalized = normalizeGitRoot(r)
    if (!roots.includes(normalized)) roots.push(normalized)
  }

  setCachedGitRoots(cacheKey, roots)
  return roots
}

/** 从 dir 逐级向上查找最近的含 .git 的目录（.git 可以是目录或 worktree 文件），找不到返回 null */
function findAncestorGitDir(dir: string): string | null {
  let current = resolve(dir)
  while (true) {
    // existsSync 通常不抛错；try/catch 仅防御极端的权限/路径错误场景
    try {
      if (existsSync(join(current, '.git'))) return current
    } catch {
      // 路径无法访问时继续向上
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** 查找 Git 仓库根目录，先向上后向下搜索，失败返回 null */
async function findGitRoot(baseDir: string): Promise<string | null> {
  const roots = await findAllGitRoots(baseDir)
  return roots[0] ?? null
}

/**
 * 获取单个文件的 unified diff
 */
export async function getFileDiff(dirPath: string, filePath: string, gitRoot?: string): Promise<string> {
  const root = gitRoot || await findGitRoot(dirPath)
  if (!root) return ''
  const safePath = normalizeSafePath(root, filePath)
  if (!safePath) {
    console.warn('[git-diff-service] getFileDiff 拒绝不安全路径:', filePath)
    return ''
  }
  const diff = await runGitCommand(['diff', '--', safePath], root)
  return diff || ''
}

/**
 * 获取文件的旧版本（git HEAD 或指定 baseRef）和新版本（磁盘）内容
 */
export async function getDiffContents(dirPath: string, filePath: string, gitRoot?: string, baseRef?: string): Promise<{ oldContent: string; newContent: string } | null> {
  const root = gitRoot || await findGitRoot(dirPath)

  // 无 git root：纯文件预览（无 git HEAD 可比较），仅读磁盘文件，安全检查依赖 dirPath
  if (!root) {
    const safePath = normalizeSafePath(dirPath, filePath)
    if (!safePath) {
      console.warn('[git-diff-service] getDiffContents 拒绝不安全路径（无 git root）:', filePath)
      return null
    }
    const fullPath = join(dirPath, safePath)
    let newContent = ''
    if (existsSync(fullPath)) {
      try {
        const st = statSync(fullPath)
        if (st.size > MAX_FILE_SIZE_BYTES) {
          console.warn('[git-diff-service] 文件超过大小上限，跳过读取:', fullPath, st.size)
        } else {
          newContent = readFileSync(fullPath, 'utf-8')
        }
      } catch {
        // 读取失败保持空字符串
      }
    }
    return { oldContent: '', newContent: normalizeLineEndings(newContent) }
  }

  const safePath = normalizeSafePath(root, filePath)
  if (!safePath) {
    console.warn('[git-diff-service] getDiffContents 拒绝不安全路径:', filePath)
    return null
  }

  // 旧版本从 git HEAD（或指定 baseRef）读取
  const ref = baseRef || 'HEAD'
  let oldContent = ''
  try {
    const oldGitContent = await runGitCommand(['show', `${ref}:${safePath}`], root)
    if (oldGitContent !== null) {
      oldContent = oldGitContent
    }
  } catch {
    // 文件在 HEAD 中不存在（新文件）
  }

  // 新版本从磁盘读取
  let newContent = ''
  const fullPath = join(root, safePath)
  if (existsSync(fullPath)) {
    try {
      const st = statSync(fullPath)
      if (st.size > MAX_FILE_SIZE_BYTES) {
        console.warn('[git-diff-service] 文件超过大小上限，跳过读取:', fullPath, st.size)
      } else {
        newContent = readFileSync(fullPath, 'utf-8')
      }
    } catch {
      // 读取失败保持空字符串
    }
  }

  return { oldContent: normalizeLineEndings(oldContent), newContent: normalizeLineEndings(newContent) }
}

/**
 * 获取未追踪文件的内容（用于显示全绿新增 diff）
 *
 * filePath 应为相对于 gitRoot 或 dirPath 的相对路径。
 * 拒绝绝对路径和 `..` 穿越。
 */
export async function getUntrackedContent(dirPath: string, filePath: string, gitRoot?: string): Promise<string> {
  if (!filePath || typeof filePath !== 'string') return ''
  const root = gitRoot || await findGitRoot(dirPath) || dirPath
  const safePath = normalizeSafePath(root, filePath)
  if (!safePath) {
    console.warn('[git-diff-service] getUntrackedContent 拒绝不安全路径:', filePath)
    return ''
  }
  const fullPath = resolve(root, safePath)
  try {
    const st = statSync(fullPath)
    if (st.size > MAX_FILE_SIZE_BYTES) {
      console.warn('[git-diff-service] 未追踪文件超过大小上限:', fullPath, st.size)
      return ''
    }
    return normalizeLineEndings(readFileSync(fullPath, 'utf-8'))
  } catch {
    return ''
  }
}

/**
 * 还原文件相对 HEAD 的所有改动（index + working tree）。
 */
export async function revertFile(dirPath: string, filePath: string, gitRoot?: string): Promise<void> {
  const root = gitRoot || await findGitRoot(dirPath)
  if (!root) throw new Error('未找到 Git 仓库')
  const safePath = normalizeSafePath(root, filePath)
  if (!safePath) {
    throw new Error(`不安全的路径: ${filePath}`)
  }
  const result = await runGitCommand(['restore', '--staged', '--worktree', '--', safePath], root)
  if (result === null) {
    throw new Error(`还原失败: git restore --staged --worktree -- ${safePath}`)
  }
}

/**
 * 解析给定路径所属 git 仓库的「主仓库根目录」。
 *
 * 对于 worktree，git 的公共目录（--git-common-dir）始终指向主仓库的 .git，
 * 因此其父目录即主仓库根。普通仓库返回自身根目录。非 git 路径返回 null。
 *
 * 用于安全校验：worktree 常被放在主仓库之外（如 ~/proma-dev/worktrees/xxx），
 * 直接判定其路径会越界；改为校验它回溯到的主仓库是否已授权。
 */
export async function getMainRepoRoot(somePath: string): Promise<string | null> {
  if (!existsSync(somePath)) return null
  const commonDir = await runGitCommand(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    somePath,
    { quiet: true },
  )
  if (!commonDir) return null
  // commonDir 形如 /path/to/main-repo/.git，取其父目录
  return normalizeGitRoot(dirname(commonDir))
}

/**
 * 列出指定仓库的所有 Git Worktree
 */
export async function listWorktrees(repoPath: string, force = false): Promise<import('@proma/shared').WorktreeInfo[]> {
  const root = await findGitRoot(repoPath)
  if (!root) return []
  return listWorktreesFromRoot(root, force)
}

/**
 * 假定 root 已是仓库根，直接列出其所有 worktree。
 *
 * 与 listWorktrees 的区别：跳过 findGitRoot 的向上 rev-parse / 向下递归扫描
 * （对大仓库可达数秒），供批量枚举仓库时复用已发现的根。
 * porcelain 输出第一个 block 即主 worktree（git 保证），不再额外跑 rev-parse。
 */
/** worktree 列表缓存 TTL：worktree 结构相对稳定（新增/删除才变），枚举避免重复 spawn git */
const WORKTREES_CACHE_TTL_MS = 10_000
const worktreesCache = new Map<string, { worktrees: import('@proma/shared').WorktreeInfo[]; expiresAt: number }>()

/** 读取未过期的 worktree 列表缓存 */
function getCachedWorktrees(gitRoot: string): import('@proma/shared').WorktreeInfo[] | null {
  const entry = worktreesCache.get(gitRoot)
  if (!entry) return null
  if (Date.now() >= entry.expiresAt) {
    worktreesCache.delete(gitRoot)
    return null
  }
  return entry.worktrees
}

/** 写入 worktree 列表缓存（带简单上限） */
function setCachedWorktrees(gitRoot: string, worktrees: import('@proma/shared').WorktreeInfo[]): void {
  worktreesCache.set(gitRoot, { worktrees, expiresAt: Date.now() + WORKTREES_CACHE_TTL_MS })
  if (worktreesCache.size > 128) {
    const oldest = worktreesCache.keys().next().value
    if (oldest !== undefined) worktreesCache.delete(oldest)
  }
}

async function listWorktreesFromRoot(root: string, force = false): Promise<import('@proma/shared').WorktreeInfo[]> {
  const cacheKey = normalizeGitRoot(root)
  if (!force) {
    const cached = getCachedWorktrees(cacheKey)
    if (cached) return cached
  }

  const output = await runGitCommand(['worktree', 'list', '--porcelain'], root, { quiet: true })
  if (!output) {
    setCachedWorktrees(cacheKey, [])
    return []
  }
  const normalizedRoot = normalizeGitRoot(root)

  const worktrees: import('@proma/shared').WorktreeInfo[] = []
  const blocks = output.split('\n\n').filter(Boolean)

  blocks.forEach((block, index) => {
    const lines = block.split('\n')
    let path = ''
    let head = ''
    let branch = ''
    let prunable = false

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length)
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length).slice(0, 7)
      } else if (line.startsWith('branch refs/heads/')) {
        branch = line.slice('branch refs/heads/'.length)
      } else if (line === 'detached') {
        branch = '(detached)'
      } else if (line.startsWith('prunable')) {
        prunable = true
      }
    }

    if (path && !prunable && existsSync(path)) {
      // porcelain 第一个 block 一定是主 worktree
      const isMain = index === 0 || normalizeGitRoot(path) === normalizedRoot
      worktrees.push({
        path,
        branch: branch || 'unknown',
        head,
        isMain,
        name: basename(path),
      })
    }
  })

  setCachedWorktrees(cacheKey, worktrees)
  return worktrees
}

/** 基准分支探测结果缓存 TTL：分支结构相对稳定，避免每次聚焦重复跑 git */
const BASE_BRANCH_CACHE_TTL_MS = 30_000
const baseBranchCache = new Map<string, { base: string; expiresAt: number }>()

/**
 * 解析默认基准分支：优先远端默认分支（origin/main → origin/master），
 * 退化本地 main/master，最后用 HEAD~1（无远端可用的相对基准）。
 *
 * 用单次 for-each-ref 枚举全部 refs（替代 4 次串行 rev-parse --verify，
 * 后者对不存在的 ref 在 Windows 上单次可达 3.6s），结果按仓库缓存 30s。
 */
async function resolveDefaultBaseBranch(gitRoot: string): Promise<string> {
  const key = normalizeGitRoot(gitRoot)
  const cached = baseBranchCache.get(key)
  if (cached && Date.now() < cached.expiresAt) return cached.base

  const output = await runGitCommand(
    ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin', 'refs/heads'],
    gitRoot,
    { quiet: true },
  )
  const refs = new Set((output || '').split('\n').filter(Boolean))
  let base = 'HEAD~1'
  for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']) {
    if (refs.has(ref)) {
      base = ref.replace('refs/remotes/origin/', 'origin/').replace('refs/heads/', '')
      break
    }
  }

  baseBranchCache.set(key, { base, expiresAt: Date.now() + BASE_BRANCH_CACHE_TTL_MS })
  return base
}

/**
 * 获取 Worktree 相对于基准分支的全量变更（已 commit + 未提交 + 新文件）
 */
export async function getWorktreeChanges(
  worktreePath: string,
  baseBranch?: string,
  options?: { skipFetch?: boolean; compareMode?: boolean },
): Promise<import('@proma/shared').UnstagedChangesResult> {
  if (!existsSync(worktreePath)) {
    return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
  }

  // 确认是 git 仓库
  const toplevel = await runGitCommand(['rev-parse', '--show-toplevel'], worktreePath)
  if (!toplevel) {
    return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
  }

  const gitRoot = normalizeGitRoot(toplevel)

  // 尝试 fetch 远端默认分支以确保 baseBranch 最新（聚合视图已统一 fetch，可跳过；无远端时静默降级）
  if (!options?.skipFetch) {
    await runGitCommand(['fetch', 'origin', '--quiet'], gitRoot, { quiet: true })
  }

  // 基准分支：显式传入优先，否则自动探测（origin/main → origin/master → …）
  const effectiveBase = baseBranch || await resolveDefaultBaseBranch(gitRoot)
  const allFiles: import('@proma/shared').ChangedFileEntry[] = []
  const fileMap = new Map<string, import('@proma/shared').ChangedFileEntry>()

  // 1. 已 commit 但未合并的改动：
  //    默认三点 diff（base...HEAD，只含共同祖先之后 HEAD 的改动）；
  //    compareMode 用两点 diff（base HEAD，展示两分支全部差异，基准独有改动以删除呈现）
  const committedRange = options?.compareMode
    ? ['diff', effectiveBase, 'HEAD']
    : ['diff', `${effectiveBase}...HEAD`]
  const committedStatus = await runGitCommand([...committedRange, '--name-status'], gitRoot)
  const committedNumstat = await runGitCommand([...committedRange, '--numstat'], gitRoot)
  const committedStats = parseNumstat(committedNumstat)

  if (committedStatus) {
    for (const line of committedStatus.split('\n').filter(Boolean)) {
      const simpleMatch = line.match(/^([MDAT])\t(.+)$/)
      const renameMatch = line.match(/^([RC])\d*\t([^\t]+)\t(.+)$/)

      let status: import('@proma/shared').ChangedFileStatus
      let filePath: string

      if (simpleMatch) {
        const code = simpleMatch[1]!
        status = code === 'D' ? 'deleted' : code === 'A' ? 'untracked' : 'modified'
        filePath = simpleMatch[2]!
      } else if (renameMatch) {
        status = 'modified'
        filePath = renameMatch[3]!
      } else {
        continue
      }

      const stats = committedStats.get(filePath) ?? { additions: 0, deletions: 0 }
      const entry: import('@proma/shared').ChangedFileEntry = {
        filePath,
        status,
        additions: stats.additions,
        deletions: stats.deletions,
        source: 'none',
        gitRoot,
      }
      fileMap.set(filePath, entry)
    }
  }

  // 2. 未提交的改动：当前工作树相对 HEAD，覆盖 staged + unstaged。
  const uncommittedStatus = await runGitCommand(['diff', 'HEAD', '--name-status'], gitRoot)
  const uncommittedNumstat = await runGitCommand(['diff', 'HEAD', '--numstat'], gitRoot)
  const uncommittedStats = parseNumstat(uncommittedNumstat)

  if (uncommittedStatus) {
    for (const line of uncommittedStatus.split('\n').filter(Boolean)) {
      const simpleMatch = line.match(/^([MDAT])\t(.+)$/)
      const renameMatch = line.match(/^([RC])\d*\t([^\t]+)\t(.+)$/)

      let status: import('@proma/shared').ChangedFileStatus
      let filePath: string

      if (simpleMatch) {
        const code = simpleMatch[1]!
        status = code === 'D' ? 'deleted' : 'modified'
        filePath = simpleMatch[2]!
      } else if (renameMatch) {
        status = 'modified'
        filePath = renameMatch[3]!
      } else {
        continue
      }

      const stats = uncommittedStats.get(filePath) ?? { additions: 0, deletions: 0 }
      const existing = fileMap.get(filePath)
      if (existing) {
        existing.additions += stats.additions
        existing.deletions += stats.deletions
      } else {
        fileMap.set(filePath, {
          filePath,
          status,
          additions: stats.additions,
          deletions: stats.deletions,
          source: 'none',
          gitRoot,
        })
      }
    }
  }

  allFiles.push(...fileMap.values())

  // 3. 新文件（未追踪）
  const untrackedFiles: import('@proma/shared').UntrackedFileEntry[] = []
  const untrackedOutput = await runGitCommand(['ls-files', '--others', '--exclude-standard'], gitRoot)
  if (untrackedOutput) {
    for (const rel of untrackedOutput.split('\n').filter(Boolean)) {
      if (!fileMap.has(rel)) {
        untrackedFiles.push({ filePath: rel, gitRoot })
      }
    }
  }

  return {
    isGitRepo: true,
    files: allFiles,
    untrackedFiles,
    gitRootNames: [basename(gitRoot)],
    baseBranch: effectiveBase,
  }
}

/**
 * 获取 worktree 领先基准分支的 commit 摘要（git log base..HEAD --oneline）。
 * 供仓库聚合视图展示「已提交但未合并」的 commit 概览。
 */
/** 解析 git log --format 输出为 CommitSummary 列表 */
function parseCommitSummaries(output: string): import('@proma/shared').CommitSummary[] {
  return output.split('\n').filter(Boolean).map((line) => {
    const [hash, author, date, ...rest] = line.split('|')
    return {
      hash: hash || '',
      author: author || '',
      date: date || '',
      subject: rest.join('|') || '',
    }
  })
}

/** 获取指定 commit 范围的摘要（rangeSpec 如 'base..HEAD' 或 'HEAD..base'） */
async function getCommitRange(worktreePath: string, rangeSpec: string): Promise<import('@proma/shared').CommitSummary[]> {
  const toplevel = await runGitCommand(['rev-parse', '--show-toplevel'], worktreePath, { quiet: true })
  if (!toplevel) return []
  const output = await runGitCommand(
    ['log', rangeSpec, '--format=%h|%an|%ad|%s', '--date=short', '--max-count=50'],
    normalizeGitRoot(toplevel),
    { quiet: true },
  )
  if (!output) return []
  return parseCommitSummaries(output)
}

/** worktree 领先基准分支的 commit 摘要（git log base..HEAD） */
async function getLeadingCommits(worktreePath: string, baseBranch: string): Promise<import('@proma/shared').CommitSummary[]> {
  return getCommitRange(worktreePath, `${baseBranch}..HEAD`)
}

/** 基准分支独有、worktree 没有的 commit 摘要（git log HEAD..base） */
async function getTrailingCommits(worktreePath: string, baseBranch: string): Promise<import('@proma/shared').CommitSummary[]> {
  return getCommitRange(worktreePath, `HEAD..${baseBranch}`)
}

/**
 * 列出指定目录下扫描到的所有 Git 仓库（含各自的所有 worktree）。
 *
 * 用于文件改动 tab 的「仓库选择器」：把工作区内发现的仓库根加入可选列表，
 * 每个仓库携带分支信息与 worktree 清单，选中后即可按仓库聚合扫描。
 * 仓库较多时并行收集（限并发），避免串行 git worktree list 拖慢下拉。
 */
export async function listRepos(baseDir: string, options?: { force?: boolean }): Promise<import('@proma/shared').RepoInfo[]> {
  if (!existsSync(baseDir)) return []

  // 仓库列表相对稳定，用短 TTL 缓存避免每次打开下拉都全量扫 git（Windows 下 spawn git 较慢）
  const cacheKey = `listRepos:${normalizeGitRoot(baseDir)}`
  const now = Date.now()
  const hit = listReposCache.get(cacheKey)
  if (!options?.force && hit && now - hit.ts < LIST_REPOS_CACHE_TTL_MS) {
    return hit.repos
  }

  // 仓库根集合：baseDir 自身若为仓库根也要纳入（skipUpward 只跳过向上 rev-parse）
  const roots: string[] = []
  if (existsSync(join(baseDir, '.git'))) {
    roots.push(normalizeGitRoot(baseDir))
  }
  for (const r of await findAllGitRoots(baseDir, { skipUpward: true })) {
    if (!roots.includes(r)) roots.push(r)
  }
  if (roots.length === 0) return []

  const CONCURRENCY = 8
  const results: (import('@proma/shared').RepoInfo | null)[] = new Array(roots.length).fill(null)
  let cursor = 0

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= roots.length) return
      const root = roots[i]!
      try {
        const worktrees = await listWorktreesFromRoot(root)
        if (worktrees.length === 0) continue
        const main = worktrees.find((wt) => wt.isMain) ?? worktrees[0]!
        results[i] = {
          repoPath: root,
          name: basename(root),
          branch: main.branch,
          head: main.head,
          worktreeCount: worktrees.length,
          worktrees,
        }
      } catch {
        // skip repos that fail
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, roots.length) }, () => worker()))
  const repos = results
    .filter((r): r is import('@proma/shared').RepoInfo => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name))

  listReposCache.set(cacheKey, { ts: now, repos })
  // 简单上限：超过 50 条时删除最早插入的条目（Map 迭代序即插入序）
  if (listReposCache.size > 50) {
    const oldestKey = listReposCache.keys().next().value as string | undefined
    if (oldestKey) listReposCache.delete(oldestKey)
  }
  return repos
}

/** 仓库聚合变更结果缓存 TTL：与变更扫描缓存一致，写文件/git 变更后由 invalidateGitDiffCache 主动失效 */
const REPO_CHANGES_CACHE_TTL_MS = 5000
interface RepoChangesCacheEntry {
  result: import('@proma/shared').RepoChangesResult
  expiresAt: number
}
const repoChangesCache = new Map<string, RepoChangesCacheEntry>()

function getCachedRepoChanges(key: string): import('@proma/shared').RepoChangesResult | null {
  const entry = repoChangesCache.get(key)
  if (!entry) return null
  if (Date.now() >= entry.expiresAt) {
    repoChangesCache.delete(key)
    return null
  }
  return entry.result
}

function setCachedRepoChanges(key: string, result: import('@proma/shared').RepoChangesResult): void {
  repoChangesCache.set(key, { result, expiresAt: Date.now() + REPO_CHANGES_CACHE_TTL_MS })
  if (repoChangesCache.size > 64) {
    const oldest = repoChangesCache.keys().next().value
    if (oldest !== undefined) repoChangesCache.delete(oldest)
  }
}

/**
 * 获取仓库所有 worktree 相对基准分支的全量变更（聚合视图）。
 *
 * 每个 worktree 复用 getWorktreeChanges 逻辑；fetch 远端只执行一次，
 * worktree 之间限并发收集，避免瞬时 spawn 过多 git 进程。
 *
 * @param options.isPathAllowed 逐 worktree 路径授权过滤（防御纵深：
 *   worktree 元数据可能指向未授权目录，不通过校验的 worktree 会被跳过）
 * @param options.sessionId 会话标识，参与缓存 key 隔离（不同会话授权范围不同）
 */
export async function getRepoChanges(
  repoPath: string,
  baseBranch?: string,
  options?: {
    isPathAllowed?: (p: string) => boolean | Promise<boolean>
    sessionId?: string
  },
): Promise<import('@proma/shared').RepoChangesResult> {
  // 5s 短 TTL 缓存：窗口聚焦等高频触发在窗口内复用，写文件后 invalidateGitDiffCache 主动失效；
  // key 含 sessionId 与授权范围隔离，避免跨会话缓存泄漏
  const cacheKey = `repo:${normalizeGitRoot(repoPath)}:${baseBranch || '*'}|${options?.sessionId || ''}`
  const cachedResult = getCachedRepoChanges(cacheKey)
  if (cachedResult) return cachedResult

  let worktrees = await listWorktrees(repoPath)
  if (options?.isPathAllowed) {
    const allowed = await Promise.all(worktrees.map((wt) => Promise.resolve(options.isPathAllowed!(wt.path))))
    worktrees = worktrees.filter((_, i) => allowed[i])
  }
  if (worktrees.length === 0) {
    return { isGitRepo: false, repoPath, baseBranch: baseBranch || '', worktrees: [] }
  }

  // fetch 一次远端（以主 worktree 为 cwd），各 worktree 内部跳过 fetch；
  // 显式指定对比基准（worktree A vs B）时无需 fetch，跳过避免无谓网络/等待；无远端时静默降级
  const main = worktrees.find((wt) => wt.isMain) ?? worktrees[0]!
  if (!baseBranch) {
    await runGitCommand(['fetch', 'origin', '--quiet'], main.path, { quiet: true })
  }

  // 基准分支：显式传入优先，否则自动探测（origin/main → origin/master → …）
  const effectiveBase = baseBranch || await resolveDefaultBaseBranch(main.path)
  // 用户显式指定对比基准（worktree A vs B）时用两点 diff，展示两分支全部差异
  // （基准分支独有改动以「删除」呈现，与聚合视图的祖先 diff 区分）
  const compareMode = Boolean(baseBranch)

  const CONCURRENCY = 4
  const results: (import('@proma/shared').RepoWorktreeChanges | null)[] = new Array(worktrees.length).fill(null)
  let cursor = 0

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= worktrees.length) return
      const wt = worktrees[i]!
      try {
        const [changes, commits, trailingCommits] = await Promise.all([
          getWorktreeChanges(wt.path, effectiveBase, { skipFetch: true, compareMode }),
          getLeadingCommits(wt.path, effectiveBase),
          getTrailingCommits(wt.path, effectiveBase),
        ])
        results[i] = { worktree: wt, changes, commits, trailingCommits }
      } catch {
        // skip worktrees that fail
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, worktrees.length) }, () => worker()))

  const result: import('@proma/shared').RepoChangesResult = {
    isGitRepo: true,
    repoPath,
    baseBranch: effectiveBase,
    worktrees: results.filter((r): r is import('@proma/shared').RepoWorktreeChanges => r !== null),
  }
  setCachedRepoChanges(cacheKey, result)
  return result
}