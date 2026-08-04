/**
 * DiffChangesList — 代码改动文件列表
 *
 * 显示当前工作树相对 HEAD 的代码改动，按目录分组，支持 hover 操作按钮。
 * 同时支持「仓库选择器」：选中仓库后聚合展示该仓库所有 worktree 的变更与分支对比。
 * 非 Git 目录下的会话文件变更（non-git）也在此展示。
 */

import * as React from 'react'
import { Box, ChevronRight, FolderSearch, GitBranch, Search, Undo2, X } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { agentDiffUnseenFilesAtom, agentDiffDataAtom, agentDiffRepoDataAtom, agentSelectedWorktreeAtom, agentSelectedRepoAtom, agentDiffBaseBranchAtom } from '@/atoms/agent-atoms'
import type { ChangedFileEntry, ChangedFileStatus, ChangeSource, UntrackedFileEntry, WorktreeInfo, RepoChangesResult, RepoWorktreeChanges } from '@proma/shared'
import { WorktreeSelector } from './WorktreeSelector'
import { RepoSelector } from './RepoSelector'
import { groupSessionFileChanges } from '@/lib/session-file-changes'
import type { SessionFileChange } from '@/lib/session-file-changes'

interface GitFileEntry {
  filePath: string
  status: ChangedFileStatus
  additions: number
  deletions: number
  source?: ChangeSource
  gitRoot: string
}

/** 按目录分组后的数据结构 */
interface FileGroup {
  /** 完整 Git 仓库路径（用作 React key，避免同名目录冲突） */
  gitRoot: string
  /** 显示用的目录名（仓库的最后一段） */
  dirName: string
  files: GitFileEntry[]
  totalAdditions: number
  totalDeletions: number
  sources: ChangeSource[]
}

interface DiffChangesListProps {
  /** Git 仓库根目录 */
  dirPath: string
  /** 当前 Agent 会话 ID，用于主进程路径授权 */
  sessionId: string
  /** 会话工作目录（用于 badge 计算） */
  sessionPath?: string
  /** 工作区共享文件目录（用于 badge 计算） */
  workspaceFilesPath?: string
  /** 点击文件回调 */
  onFileClick: (filePath: string, isUntracked: boolean, gitRoot?: string, baseRef?: string) => void
  /** 自动刷新信号（版本号递增触发） */
  refreshVersion?: number
  /** 当前选中的文件路径（高亮显示） */
  selectedFilePath?: string
  /** 额外的候选目录（附加目录等） */
  extraPaths?: string[]
  /** 工作区 slug，用于 WorktreeSelector 拉取 worktree 列表 */
  workspaceSlug?: string
  /** 用于自动发现 worktree 的仓库候选路径 */
  worktreeRepoPaths?: string[]
  /** 本会话的 non-git 文件变更（非 Git 目录下的会话文件） */
  nonGitFileChanges?: SessionFileChange[]
  /** 当前文件变更 run id（区分本轮/更早） */
  currentFileChangeRunId?: string
  /** non-git 文件点击回调 */
  onPlainFileClick?: (filePath: string) => void
}

/** 文件来源 badge 的颜色和文案 */
const SOURCE_CONFIG: Record<string, { color: string; label: string }> = {
  session: { color: 'bg-blue-500/10 text-blue-500', label: '会话文件' },
  workspace: { color: 'bg-purple-500/10 text-purple-500', label: '项目文件' },
  both: { color: 'bg-cyan-500/10 text-cyan-500', label: '会话+项目文件' },
  none: { color: 'bg-muted text-muted-foreground', label: '附加目录文件' },
}

export const DiffChangesList = React.memo(function DiffChangesList({
  dirPath,
  sessionPath,
  sessionId,
  workspaceFilesPath,
  onFileClick,
  refreshVersion,
  selectedFilePath,
  extraPaths,
  workspaceSlug,
  worktreeRepoPaths,
  nonGitFileChanges = [],
  currentFileChangeRunId,
  onPlainFileClick,
}: DiffChangesListProps): React.ReactElement {
  // Worktree 选择状态（内联 WorktreeSelector）
  const selectedWorktreeMap = useAtomValue(agentSelectedWorktreeAtom)
  const setSelectedWorktreeMap = useSetAtom(agentSelectedWorktreeAtom)
  const selectedWorktreePath = selectedWorktreeMap.get(sessionId) ?? null
  // 仓库选择状态（内联 RepoSelector，优先级高于 worktree）
  const selectedRepoMap = useAtomValue(agentSelectedRepoAtom)
  const setSelectedRepoMap = useSetAtom(agentSelectedRepoAtom)
  const selectedRepoPath = selectedRepoMap.get(sessionId) ?? null
  const repoMode = Boolean(selectedRepoPath)
  // 对比基准分支（worktree A vs B）：用户显式选择，空 = 服务端自动探测
  const baseBranchMap = useAtomValue(agentDiffBaseBranchAtom)
  const setBaseBranchMap = useSetAtom(agentDiffBaseBranchAtom)
  const diffBaseBranch = baseBranchMap.get(sessionId) ?? ''
  const handleRepoSelect = React.useCallback((repo: import('@proma/shared').RepoInfo | null) => {
    setSelectedRepoMap((prev) => {
      const m = new Map(prev)
      m.set(sessionId, repo?.repoPath ?? null)
      return m
    })
  }, [sessionId, setSelectedRepoMap])

  const handleWorktreeSelect = React.useCallback((worktree: WorktreeInfo | null) => {
    setSelectedWorktreeMap((prev) => {
      const m = new Map(prev)
      m.set(sessionId, worktree?.path ?? null)
      return m
    })
    // 切换 worktree 时清除对比基准，避免旧基准串到新 worktree
    setBaseBranchMap((prev) => {
      if (!prev.has(sessionId)) return prev
      const m = new Map(prev)
      m.delete(sessionId)
      return m
    })
  }, [sessionId, setSelectedWorktreeMap, setBaseBranchMap])

  // Diff 数据缓存：mount 时若已有上次结果，立即用作初值，避免空数组闪 1s "没有代码改动"
  const diffDataMap = useAtomValue(agentDiffDataAtom)
  const setDiffDataMap = useSetAtom(agentDiffDataAtom)
  // 仓库模式专用缓存（类型不同，独立 atom 避免与 UnstagedChangesResult 混用）
  const repoDataMap = useAtomValue(agentDiffRepoDataAtom)
  const setRepoDataMap = useSetAtom(agentDiffRepoDataAtom)
  const diffCacheKey = repoMode
    ? (selectedWorktreePath ? `${sessionId}:repo-wt:${selectedWorktreePath}` : `${sessionId}:repo:${selectedRepoPath}`)
    : selectedWorktreePath ? `${sessionId}:worktree:${selectedWorktreePath}` : `${sessionId}:session`
  const cached = diffDataMap.get(diffCacheKey)
  const [files, setFiles] = React.useState<ChangedFileEntry[]>(() => cached?.files ?? [])
  const [untrackedFiles, setUntrackedFiles] = React.useState<UntrackedFileEntry[]>(() => cached?.untrackedFiles ?? [])
  const [isGitRepo, setIsGitRepo] = React.useState(() => cached?.isGitRepo ?? true)
  // 仓库聚合模式（repoMode && 未选单 worktree）：数据在 agentDiffRepoDataAtom，与 worktree 视图分离
  const isRepoAggregate = repoMode && !selectedWorktreePath
  // 仓库模式：所有 worktree 的聚合变更
  const [repoChanges, setRepoChanges] = React.useState<RepoChangesResult | null>(() => {
    if (!isRepoAggregate) return null
    return repoDataMap.get(diffCacheKey) ?? null
  })
  // 实际使用的基准分支（服务端自动探测后返回），用于文件 diff 预览对齐
  const [worktreeBaseBranch, setWorktreeBaseBranch] = React.useState<string>('')
  /** 首次 fetch 是否已返回——区分 loading 与真·空，避免 "没有代码改动" 误闪 */
  const [hasFetched, setHasFetched] = React.useState<boolean>(() => isRepoAggregate ? repoDataMap.has(diffCacheKey) : cached !== undefined)
  const [collapsedDirs, setCollapsedDirs] = React.useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = React.useState('')
  /** 单调递增的 fetch 序号，用于丢弃乱序到达的旧响应 */
  const fetchSeqRef = React.useRef(0)

  // eslint-disable-next-line react-hooks/exhaustive-deps -- only reset state on cache key switch, not on every diffDataMap update
  React.useEffect(() => {
    fetchSeqRef.current += 1
    const nextCached = diffDataMap.get(diffCacheKey)
    setFiles(nextCached?.files ?? [])
    setUntrackedFiles(nextCached?.untrackedFiles ?? [])
    setIsGitRepo(nextCached?.isGitRepo ?? true)
    setHasFetched(isRepoAggregate ? repoDataMap.has(diffCacheKey) : nextCached !== undefined)
    if (isRepoAggregate) {
      setRepoChanges(repoDataMap.get(diffCacheKey) ?? null)
    }
  }, [diffCacheKey, repoMode, isRepoAggregate])

  // Agent 本轮刚修改但尚未查看的文件
  const unseenFilesMap = useAtomValue(agentDiffUnseenFilesAtom)
  const setUnseenFilesMap = useSetAtom(agentDiffUnseenFilesAtom)
  const unseenFiles = unseenFilesMap.get(sessionId) ?? new Set<string>()

  const markFileAsSeen = React.useCallback((filePath: string) => {
    setUnseenFilesMap((prev) => {
      const s = prev.get(sessionId)
      if (!s?.has(filePath)) return prev
      const m = new Map(prev)
      const next = new Set(s)
      next.delete(filePath)
      m.set(sessionId, next)
      return m
    })
  }, [sessionId, setUnseenFilesMap])

  const fetchChanges = React.useCallback(async () => {
    if (!dirPath && !repoMode) return
    const requestId = ++fetchSeqRef.current
    try {
      if (repoMode && selectedRepoPath) {
        // 聚合视图自动探测基准；worktree 细化传用户选择的对比基准（A vs B）
        const result = await window.electronAPI.getRepoChanges(selectedRepoPath, isRepoAggregate ? '' : diffBaseBranch, sessionId)
        if (requestId !== fetchSeqRef.current) return
        setIsGitRepo(result.isGitRepo)
        if (isRepoAggregate) {
          setRepoChanges(result)
          setFiles([])
          setUntrackedFiles([])
          setRepoDataMap((prev) => {
            const next = new Map(prev)
            next.set(diffCacheKey, result)
            return next
          })
        } else {
          // 仓库内选中单个 worktree：从聚合结果中取出对应 worktree 的变更，放入 diffDataMap
          const target = result.worktrees.find((w) => w.worktree.path === selectedWorktreePath)
          const changes = target?.changes ?? { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
          setFiles(changes.files || [])
          setUntrackedFiles(changes.untrackedFiles || [])
          setWorktreeBaseBranch(target?.worktree.path ? (result.baseBranch || '') : '')
          setDiffDataMap((prev) => {
            const next = new Map(prev)
            next.set(diffCacheKey, changes)
            return next
          })
        }
        setHasFetched(true)
        return
      }
      const result = await window.electronAPI.getUnstagedChanges(dirPath, sessionPath, workspaceFilesPath, extraPaths, sessionId)
      if (requestId !== fetchSeqRef.current) return
      setIsGitRepo(result.isGitRepo)
      setFiles(result.files || [])
      setUntrackedFiles(result.untrackedFiles || [])
      setHasFetched(true)
      setDiffDataMap((prev) => {
        const next = new Map(prev)
        next.set(diffCacheKey, result)
        return next
      })
    } catch {
      if (requestId !== fetchSeqRef.current) return
      setIsGitRepo(true)
      setHasFetched(true)
    }
  }, [dirPath, sessionPath, workspaceFilesPath, extraPaths, sessionId, setDiffDataMap, setRepoDataMap, diffCacheKey, repoMode, selectedRepoPath, isRepoAggregate, diffBaseBranch])

  React.useEffect(() => {
    fetchChanges()
  }, [fetchChanges, refreshVersion])

  // 窗口聚焦刷新已统一在 useGlobalAgentListeners 中处理（递增 refreshVersion）

  /** Revert 文件 */
  const handleRevert = React.useCallback(async (filePath: string, gitRoot: string) => {
    if (!window.confirm(`确定要还原 ${filePath} 的所有变更吗？此操作不可撤销。`)) return
    try {
      await window.electronAPI.revertFile({ dirPath, filePath, gitRoot, sessionId })
      await fetchChanges()
    } catch (err) {
      window.alert(`还原失败：${err instanceof Error ? err.message : '未知错误'}`)
    }
  }, [dirPath, fetchChanges, sessionId])

  /** 切换文件夹折叠 */
  const toggleDir = React.useCallback((dirName: string) => {
    setCollapsedDirs(prev => {
      const next = new Set(prev)
      if (next.has(dirName)) {
        next.delete(dirName)
      } else {
        next.add(dirName)
      }
      return next
    })
  }, [])

  // 按 Git 仓库分组（在所有 hooks 之后、条件返回之前调用）
  const { fileGroups, matchedFilesCount } = React.useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    const allFiles: GitFileEntry[] = [
      ...files,
      ...untrackedFiles.map((file) => ({
        ...file,
        status: 'untracked' as const,
        additions: 0,
        deletions: 0,
      })),
    ]
    const filteredFiles = q
      ? allFiles.filter((file) => file.filePath.toLowerCase().includes(q))
      : allFiles

    // 用完整 gitRoot 做 key，避免同名目录冲突。
    const groups = new Map<string, GitFileEntry[]>()
    for (const file of filteredFiles) {
      const key = file.gitRoot || ''
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(file)
    }
    const result: FileGroup[] = [...groups.entries()].map(([gitRoot, groupFiles]) => ({
      gitRoot,
      dirName: gitRoot ? gitRoot.split('/').pop() || gitRoot : '/',
      files: groupFiles,
      totalAdditions: groupFiles.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: groupFiles.reduce((sum, file) => sum + file.deletions, 0),
      sources: [...new Set(groupFiles.flatMap((file) => file.source ? [file.source] : []))],
    }))
    return { fileGroups: result, matchedFilesCount: filteredFiles.length }
  }, [files, untrackedFiles, searchQuery])

  const isEmpty = fileGroups.length === 0
  const hasAnyChanges = files.length > 0 || untrackedFiles.length > 0
  const hasGitChanges = isGitRepo && hasAnyChanges
  const hasNonGitFileChanges = nonGitFileChanges.length > 0
  const hasAnyVisibleChanges = hasGitChanges || hasNonGitFileChanges
  // 仓库聚合模式：搜索框基于聚合结果判断；worktree 细化/默认视图基于 files
  const repoTotalChanges = repoChanges
    ? repoChanges.worktrees.reduce((s, w) => s + w.changes.files.length + w.changes.untrackedFiles.length, 0)
    : 0
  const shouldShowSearch = isGitRepo && (isRepoAggregate
    ? (repoTotalChanges > 0 || searchQuery.length > 0)
    : (hasAnyChanges || searchQuery.length > 0))
  const shouldShowWorktreeSelector = repoMode && Boolean(selectedRepoPath)
  const shouldShowRepoSelector = (worktreeRepoPaths?.length ?? 0) > 0

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* 仓库选择器 — 选择后该会话只扫描此仓库的所有 worktree */}
      {shouldShowRepoSelector && (
        <RepoSelector
          sessionId={sessionId}
          repoPaths={worktreeRepoPaths}
          workspaceSlug={workspaceSlug || undefined}
          selectedPath={selectedRepoPath}
          onSelect={handleRepoSelect}
        />
      )}
      {/* Worktree 过滤条 — 选中仓库后可在聚合视图与单个 worktree 之间切换 */}
      {shouldShowWorktreeSelector && selectedRepoPath && (
        <WorktreeSelector
          sessionId={sessionId}
          repoPath={selectedRepoPath}
          selectedPath={selectedWorktreePath}
          onSelect={handleWorktreeSelect}
          baseBranch={diffBaseBranch || undefined}
          onBaseBranchChange={(base) => {
            setBaseBranchMap((prev) => {
              const m = new Map(prev)
              if (base) m.set(sessionId, base)
              else m.delete(sessionId)
              return m
            })
          }}
        />
      )}

      {/* 搜索框 — 有改动文件时才显示 */}
      {shouldShowSearch && (
        <div className="flex-shrink-0 sticky top-0 z-10 bg-content-area px-2 pt-1.5 pb-1">
          <div className="flex items-center gap-1.5 px-2 h-7 rounded-md bg-muted/50 border border-transparent focus-within:border-primary/40 focus-within:bg-muted/70 transition-colors">
            <Search className="size-3 text-muted-foreground flex-shrink-0" />
            <input
              type="text"
              aria-label="搜索改动文件"
              className="flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/40"
              placeholder="搜索改动文件..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <>
                <span className="text-[10px] text-muted-foreground/50 flex-shrink-0 tabular-nums">
                  {matchedFilesCount}
                </span>
                <button
                  type="button"
                  aria-label="清除搜索"
                  className="flex-shrink-0 p-0.5 rounded-sm hover:bg-foreground/[0.08] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                  onClick={() => setSearchQuery('')}
                >
                  <X className="size-3" />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* non-git 会话文件变更 — 仅在非仓库聚合视图显示 */}
      {!isRepoAggregate && hasNonGitFileChanges && (
        <NonGitChangesList
          changes={nonGitFileChanges}
          currentRunId={currentFileChangeRunId}
          sessionId={sessionId}
          onFileClick={onPlainFileClick}
        />
      )}

      {isRepoAggregate ? (
        <RepoChangesView
          result={repoChanges}
          hasFetched={hasFetched}
          isGitRepo={isGitRepo}
          searchQuery={searchQuery}
          selectedFilePath={selectedFilePath}
          unseenFiles={unseenFiles}
          markFileAsSeen={markFileAsSeen}
          onFileClick={onFileClick}
          onRevert={handleRevert}
        />
      ) : (
        <>
          {!hasAnyVisibleChanges && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
              <p className="text-[12px] text-center">
                {isGitRepo ? (hasFetched ? '没有文件改动' : '加载中…') : '当前目录不是 Git 仓库'}
              </p>
            </div>
          )}
          {hasGitChanges && isEmpty && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
              <p className="text-[12px] text-center">没有匹配的代码改动</p>
            </div>
          )}
          {hasGitChanges && !isEmpty && (
            <>
              {fileGroups.map((group) => {
                const isCollapsed = collapsedDirs.has(group.gitRoot)
                return (
                  <div key={group.gitRoot}>
                    {/* 文件夹 bar */}
                    <button
                      type="button"
                      onClick={() => toggleDir(group.gitRoot)}
                      className="flex items-center gap-1.5 w-full px-3 py-2 text-[13px] font-medium text-foreground/60 hover:bg-foreground/[0.04] transition-colors"
                    >
                      <ChevronRight
                        className={cn('size-3.5 transition-transform', !isCollapsed && 'rotate-90')}
                      />
                      <span className="truncate">{group.dirName}</span>
                      {/* 文件夹层级的来源 badges */}
                      {group.sources.map((src) => {
                        const cfg = SOURCE_CONFIG[src] ?? SOURCE_CONFIG.none!
                        return (
                          <span key={src} className={cn('rounded px-1 py-0.5 text-[12px] leading-none shrink-0', cfg.color)}>
                            {cfg.label}
                          </span>
                        )
                      })}
                      <span className="ml-auto shrink-0 flex items-center gap-1.5">
                        <span className="text-foreground/30">{group.files.length} files</span>
                        {group.totalAdditions > 0 && <span className="text-foreground/30">+{group.totalAdditions}</span>}
                        {group.totalDeletions > 0 && <span className="text-foreground/30">-{group.totalDeletions}</span>}
                      </span>
                    </button>

                    {/* 文件列表 */}
                    {!isCollapsed && group.files.map((file) => {
                      const absPath = `${file.gitRoot || dirPath}/${file.filePath}`.replace(/\/+/g, '/')
                      return (
                        <FileRow
                          key={`${file.gitRoot}:${file.filePath}`}
                          file={file}
                          isSelected={absPath === selectedFilePath || file.filePath === selectedFilePath}
                          isUnseen={unseenFiles.has(absPath)}
                          onClick={() => {
                            markFileAsSeen(absPath)
                            onFileClick(file.filePath, file.status === 'untracked', file.gitRoot, worktreeBaseBranch || undefined)
                          }}
                          onRevert={file.status === 'untracked' ? undefined : () => handleRevert(file.filePath, file.gitRoot)}
                          dirPath={dirPath}
                        />
                      )
                    })}
                  </div>
                )
              })}
            </>
          )}
        </>
      )}
    </div>
  )
})

function NonGitChangesList({
  changes,
  currentRunId,
  sessionId,
  onFileClick,
}: {
  changes: SessionFileChange[]
  currentRunId?: string
  sessionId: string
  onFileClick?: (filePath: string) => void
}): React.ReactElement {
  const { current, earlier } = groupSessionFileChanges(changes, currentRunId)
  const hasEarlierChanges = earlier.length > 0
  const title = hasEarlierChanges
    ? `本会话文件变更 · ${changes.length}`
    : `本会话文件变更 · 本轮 · ${current.length}`

  return (
    <div className="shrink-0 py-1">
      <div className="flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium text-muted-foreground tabular-nums">
        <Box className="size-3.5 shrink-0" />
        <span>{title}</span>
      </div>
      {hasEarlierChanges ? (
        <>
          {current.length > 0 && <NonGitRunGroup title="本轮" changes={current} sessionId={sessionId} onFileClick={onFileClick} />}
          <NonGitRunGroup title="更早" changes={earlier} sessionId={sessionId} onFileClick={onFileClick} />
        </>
      ) : (
        <NonGitFileList changes={current} sessionId={sessionId} onFileClick={onFileClick} />
      )}
    </div>
  )
}

function NonGitRunGroup({
  title,
  changes,
  sessionId,
  onFileClick,
}: {
  title: string
  changes: SessionFileChange[]
  sessionId: string
  onFileClick?: (filePath: string) => void
}): React.ReactElement {
  return (
    <section className="pb-2">
      <div className="px-3 py-1 text-[11px] font-medium text-muted-foreground tabular-nums">{title} · {changes.length}</div>
      <NonGitFileList changes={changes} sessionId={sessionId} onFileClick={onFileClick} />
    </section>
  )
}

function NonGitFileList({
  changes,
  sessionId,
  onFileClick,
}: {
  changes: SessionFileChange[]
  sessionId: string
  onFileClick?: (filePath: string) => void
}): React.ReactElement {
  return (
    <div>
      {changes.map((change) => {
        const parts = change.path.split(/[\\/]/)
        const name = parts.pop() || change.path
        const parent = getCompactFilePath(parts.filter(Boolean).join('/'))
        return (
          <div key={change.path} className="group flex h-9 items-center hover:bg-primary/5 transition-colors">
            <Tooltip delayDuration={700}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onFileClick?.(change.path)}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left text-sm"
                >
                  <FileTypeIcon name={name} isDirectory={false} size={16} />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{name}</span>
                  {parent && <span className="max-w-[40%] truncate text-[11px] text-muted-foreground">{parent}</span>}
                  {change.kind === 'created' && (
                    <span className="shrink-0 rounded-sm bg-orange-500/10 px-1.5 py-0.5 text-[11px] font-medium text-orange-600 dark:text-orange-400">新建</span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-[400px] break-all">{change.path}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="在文件夹中显示"
                  onClick={() => window.electronAPI.showInFolder(change.path, { sessionId }).catch(console.error)}
                  className="mr-1 flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
                >
                  <FolderSearch className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">在文件夹中显示</TooltipContent>
            </Tooltip>
          </div>
        )
      })}
    </div>
  )
}

function getCompactFilePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+\//, '~/')
}

/** Git 文件行：已追踪和未追踪文件共用同一布局。 */
function FileRow({
  file,
  onClick,
  onRevert,
  isSelected,
  isUnseen,
  dirPath,
}: {
  file: GitFileEntry
  onClick: () => void
  onRevert?: () => void
  isSelected?: boolean
  isUnseen?: boolean
  dirPath: string
}): React.ReactElement {
  const parts = file.filePath.split('/')
  const fileName = parts.pop()!
  const dir = parts.join('/')
  const fullPath = `${file.gitRoot || dirPath}/${file.filePath}`.replace(/\/+/g, '/')
  const hasLineChanges = file.additions > 0 || file.deletions > 0

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'flex items-center w-full px-2 pl-3 h-[36px] text-[14px] transition-colors group',
        isSelected
          ? 'session-item-selected bg-primary/10 shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
          : 'hover:bg-primary/5',
      )}
      onClick={onClick}
    >
      <span className="w-3 shrink-0 flex items-center justify-center">
        {isUnseen && <span className="size-1.5 rounded-full bg-primary" />}
      </span>
      <FileTypeIcon name={fileName} isDirectory={false} size={16} />
      <Tooltip delayDuration={900}>
        <TooltipTrigger asChild>
          <span className="ml-1.5 truncate flex items-baseline gap-1.5 min-w-0">
            <span className="shrink-0">{fileName}</span>
            {dir && (
              <span className="text-[11px] text-foreground/30 truncate">{dir}</span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[400px] break-all">{fullPath}</TooltipContent>
      </Tooltip>

      {hasLineChanges && (
        <span className="ml-auto shrink-0 flex items-center gap-1.5 text-[13px] tabular-nums group-hover:hidden">
          {file.additions > 0 && (
            <span style={{ color: 'rgb(34 197 94)' }}>+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span style={{ color: 'rgb(239 68 68)' }}>-{file.deletions}</span>
          )}
        </span>
      )}

      {onRevert && (
        <span className="ml-auto shrink-0 hidden group-hover:flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="还原文件变更"
                className="flex size-8 items-center justify-center rounded text-foreground/40 hover:bg-foreground/[0.08] hover:text-foreground/70"
                onClick={onRevert}
              >
                <Undo2 className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">还原文件变更</TooltipContent>
          </Tooltip>
        </span>
      )}

      <GitStatusMarker status={file.status} className={onRevert ? 'ml-2' : 'ml-auto'} />
    </div>
  )
}

function GitStatusMarker({
  status,
  className,
}: {
  status: ChangedFileStatus
  className?: string
}): React.ReactElement {
  const config: Record<ChangedFileStatus, { label: string; description: string; color: string }> = {
    modified: { label: 'M', description: '已修改', color: 'text-amber-500' },
    deleted: { label: 'D', description: '已删除', color: 'text-red-500' },
    untracked: { label: 'U', description: '未追踪', color: 'text-emerald-500' },
  }
  const { label, description, color } = config[status]

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('w-4 shrink-0 text-right text-[12px] font-medium tabular-nums', className, color)}>{label}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{description}</TooltipContent>
    </Tooltip>
  )
}

interface RepoChangesViewProps {
  result: RepoChangesResult | null
  hasFetched: boolean
  isGitRepo: boolean
  searchQuery: string
  selectedFilePath?: string
  unseenFiles: Set<string>
  markFileAsSeen: (filePath: string) => void
  onFileClick: (filePath: string, isUntracked: boolean, gitRoot?: string, baseRef?: string) => void
  onRevert: (filePath: string, gitRoot: string) => void
}

/**
 * 仓库聚合视图 — 展示所选仓库所有 worktree 的变更（含领先分支的 commit 概览）。
 *
 * 每个 worktree 是一个可折叠分组：标题为分支名 + head + 统计，
 * 展开后依次是领先 commit 列表、基准独有 commit、已追踪文件、未追踪文件。
 */
function RepoChangesView({
  result,
  hasFetched,
  isGitRepo,
  searchQuery,
  selectedFilePath,
  unseenFiles,
  markFileAsSeen,
  onFileClick,
  onRevert,
}: RepoChangesViewProps): React.ReactElement {
  const [collapsedWorktrees, setCollapsedWorktrees] = React.useState<Set<string>>(new Set())
  const toggleWorktree = React.useCallback((key: string) => {
    setCollapsedWorktrees((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const q = searchQuery.toLowerCase().trim()

  if (!isGitRepo) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <p className="text-[12px] text-center">当前目录不是 Git 仓库</p>
      </div>
    )
  }

  if (!result || result.worktrees.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <p className="text-[12px] text-center">{hasFetched ? '没有代码改动' : '加载中…'}</p>
      </div>
    )
  }

  const totalChanges = result.worktrees.reduce(
    (sum, w) => sum + w.changes.files.length + w.changes.untrackedFiles.length,
    0,
  )
  const totalCommits = result.worktrees.reduce((sum, w) => sum + w.commits.length + w.trailingCommits.length, 0)
  if (totalChanges === 0 && totalCommits === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <p className="text-[12px] text-center">{hasFetched ? '没有代码改动' : '加载中…'}</p>
      </div>
    )
  }

  return (
    <>
      {result.worktrees.map((w: RepoWorktreeChanges) => {
        const changes = w.changes
        const key = w.worktree.path
        const isCollapsed = collapsedWorktrees.has(key)
        const files = changes.files.filter((f) => !q || f.filePath.toLowerCase().includes(q))
        const untracked = changes.untrackedFiles.filter((f) => !q || f.filePath.toLowerCase().includes(q))
        const totalAdd = files.reduce((s, f) => s + f.additions, 0)
        const totalDel = files.reduce((s, f) => s + f.deletions, 0)
        const hasContent = files.length > 0 || untracked.length > 0 || w.commits.length > 0 || w.trailingCommits.length > 0
        if (!hasContent) return null
        return (
          <div key={key}>
            {/* worktree 标题 bar */}
            <button
              type="button"
              onClick={() => toggleWorktree(key)}
              aria-expanded={!isCollapsed}
              className="flex items-center gap-1.5 w-full px-2 py-2 text-[13px] font-medium text-foreground/60 hover:bg-foreground/[0.04] transition-colors"
            >
              <ChevronRight
                className={cn('size-3 shrink-0 transition-transform', !isCollapsed && 'rotate-90')}
              />
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate">{w.worktree.branch}</span>
              {w.worktree.isMain && (
                <span className="text-[10px] px-1 rounded bg-muted text-muted-foreground shrink-0">main</span>
              )}
              <span className="text-[10px] text-muted-foreground/50 shrink-0">{w.worktree.head}</span>
              {w.commits.length > 0 && (
                <span className="text-[10px] px-1 rounded bg-blue-500/10 text-blue-500 shrink-0">
                  +{w.commits.length}
                </span>
              )}
              {w.trailingCommits.length > 0 && (
                <span className="text-[10px] px-1 rounded bg-amber-500/10 text-amber-500 shrink-0" title={`${result?.baseBranch || '基准'} 独有 ${w.trailingCommits.length} commits`}>
                  -{w.trailingCommits.length}
                </span>
              )}
              <span className="ml-auto shrink-0 flex items-center gap-1.5 text-foreground/30">
                <span>{files.length + untracked.length} 文件</span>
                {totalAdd > 0 && <span>+{totalAdd}</span>}
                {totalDel > 0 && <span>-{totalDel}</span>}
              </span>
            </button>

            {!isCollapsed && (
              <>
                {/* 领先基准分支的 commit 概览（graph 摘要） */}
                {w.commits.length > 0 && (
                  <div className="px-3 py-1 border-l-2 border-border/40 ml-3 flex flex-col gap-1 bg-muted/20">
                    <div className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">
                      领先 {result?.baseBranch || '基准'} · {w.commits.length} commits
                    </div>
                    {w.commits.map((c) => (
                      <div key={c.hash} className="flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
                        <span className="text-foreground/40 font-mono tabular-nums shrink-0">{c.hash}</span>
                        <span className="truncate">{c.subject}</span>
                        <span className="text-foreground/25 shrink-0 hidden min-[360px]:inline">
                          {c.author} · {c.date}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* 基准分支独有、该 worktree 没有的 commit（对比基准时区分选择效果） */}
                {w.trailingCommits.length > 0 && (
                  <div className="px-3 py-1 border-l-2 border-amber-500/30 ml-3 flex flex-col gap-1 bg-amber-500/[0.04]">
                    <div className="text-[10px] font-medium text-amber-600/70 dark:text-amber-500/70 uppercase tracking-wider">
                      {result?.baseBranch || '基准'} 独有 · {w.trailingCommits.length} commits
                    </div>
                    {w.trailingCommits.map((c) => (
                      <div key={c.hash} className="flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
                        <span className="text-foreground/40 font-mono tabular-nums shrink-0">{c.hash}</span>
                        <span className="truncate">{c.subject}</span>
                        <span className="text-foreground/25 shrink-0 hidden min-[360px]:inline">
                          {c.author} · {c.date}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* 已追踪文件 */}
                {files.map((file) => {
                  const absPath = `${file.gitRoot || w.worktree.path}/${file.filePath}`.replace(/\/+/g, '/')
                  return (
                    <FileRow
                      key={`${file.gitRoot}:${file.filePath}`}
                      file={file}
                      isSelected={absPath === selectedFilePath || file.filePath === selectedFilePath}
                      isUnseen={unseenFiles.has(absPath)}
                      onClick={() => { markFileAsSeen(absPath); onFileClick(file.filePath, false, file.gitRoot, result?.baseBranch || undefined) }}
                      onRevert={() => onRevert(file.filePath, file.gitRoot)}
                      dirPath={w.worktree.path}
                    />
                  )
                })}

                {/* 未追踪文件 */}
                {untracked.length > 0 && (
                  <div>
                    <div className="flex items-center px-3 py-1.5 text-[12px] font-medium text-muted-foreground border-t border-border/30">
                      未追踪文件
                    </div>
                    {untracked.map((file) => (
                      <FileRow
                        key={`${file.gitRoot}:${file.filePath}`}
                        file={{ ...file, status: 'untracked', additions: 0, deletions: 0 }}
                        onClick={() => onFileClick(file.filePath, true, file.gitRoot, result?.baseBranch || undefined)}
                        dirPath={w.worktree.path}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )
      })}
    </>
  )
}
