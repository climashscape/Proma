import * as React from 'react'
import { GitBranch, GitFork, Plus, ChevronDown, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RepoInfo } from '@proma/shared'
import { normalizePathForCompare } from '@proma/shared'

interface RepoSelectorProps {
  sessionId: string
  /** 扫描根路径（通常是项目根 + 会话路径 + 附加目录） */
  repoPaths?: string[]
  /** 工作区 slug，用于合并手动配置的 worktree 仓库 + 添加入口 */
  workspaceSlug?: string
  /** 当前选中的仓库根路径，null = 全部仓库 */
  selectedPath: string | null
  onSelect: (repo: RepoInfo | null) => void
}

function normalizePathKey(filePath: string): string {
  return normalizePathForCompare(filePath)
}

/**
 * 仓库选择器 — 文件改动 tab 顶部的仓库下拉。
 *
 * 把扫描到的 Git 仓库加入可选列表并绑定会话；选中某个仓库后，
 * 该会话的 diff 列表只扫描这个仓库的所有 worktree。
 */
export function RepoSelector({
  sessionId,
  repoPaths,
  workspaceSlug,
  selectedPath,
  onSelect,
}: RepoSelectorProps): React.ReactElement {
  const [repos, setRepos] = React.useState<RepoInfo[]>([])
  const [isOpen, setIsOpen] = React.useState(false)
  const [isLoading, setIsLoading] = React.useState(false)
  const dropdownRef = React.useRef<HTMLDivElement>(null)

  const fetchRepos = React.useCallback(async (force = false) => {
    setIsLoading(true)
    try {
      const repoMap = new Map<string, RepoInfo>()
      // 1. 手动配置的 worktree 仓库（可能不在扫描范围内）
      if (workspaceSlug) {
        try {
          const configured = await window.electronAPI.getWorktreeRepos(workspaceSlug)
          for (const repo of configured) {
            if (!repoMap.has(normalizePathKey(repo.repoPath))) {
              repoMap.set(normalizePathKey(repo.repoPath), {
                repoPath: repo.repoPath,
                name: repo.name,
                branch: '',
                head: '',
                worktreeCount: 0,
                worktrees: [],
              })
            }
          }
        } catch {
          // skip
        }
      }
      // 2. 扫描到的仓库（覆盖配置项，补充完整信息）
      for (const p of repoPaths ?? []) {
        if (!p) continue
        try {
          const list = await window.electronAPI.listRepos(p, sessionId, force)
          for (const repo of list) {
            repoMap.set(normalizePathKey(repo.repoPath), repo)
          }
        } catch {
          // skip paths that fail
        }
      }
      const sorted = Array.from(repoMap.values()).sort((a, b) => {
        // 有多个 worktree 的仓库优先（用户更可能在多分支并行工作），再按名称
        if (b.worktreeCount !== a.worktreeCount) return b.worktreeCount - a.worktreeCount
        return a.name.localeCompare(b.name)
      })
      setRepos(sorted)
    } catch {
      setRepos([])
    } finally {
      setIsLoading(false)
    }
  }, [repoPaths, sessionId, workspaceSlug])

  React.useEffect(() => {
    fetchRepos()
  }, [fetchRepos])

  // 已选仓库被移除/路径失效时自动回退到「全部仓库」，避免聚合视图卡在无效路径
  React.useEffect(() => {
    if (selectedPath && repos.length > 0 && !repos.some((r) => normalizePathKey(r.repoPath) === normalizePathKey(selectedPath))) {
      onSelect(null)
    }
  }, [repos, selectedPath, onSelect])

  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // 无可用仓库时不渲染选择器（但有手动添加入口的工作区除外，保留「添加仓库」可达）
  if (repos.length === 0 && !isLoading && !workspaceSlug) return <></>

  const selectedRepo = repos.find((r) => normalizePathKey(r.repoPath) === normalizePathKey(selectedPath ?? '')) ?? null
  const displayLabel = selectedRepo
    ? `${selectedRepo.name} · ${selectedRepo.branch} · ${selectedRepo.worktreeCount} 工作树`
    : '全部仓库'

  return (
    <div ref={dropdownRef} className="relative px-3 py-1.5 border-b border-border/50">
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          aria-label="选择仓库"
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs',
            'hover:bg-accent/50 transition-colors',
            'text-muted-foreground hover:text-foreground',
            selectedRepo && 'text-foreground font-medium',
          )}
        >
          <GitFork className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate max-w-[200px]">{displayLabel}</span>
          <ChevronDown className={cn('w-3 h-3 shrink-0 transition-transform', isOpen && 'rotate-180')} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            fetchRepos(true)
          }}
          aria-label="刷新仓库列表"
          className="p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
          title="刷新仓库列表"
        >
          <RefreshCw className={cn('w-3 h-3', isLoading && 'animate-spin')} />
        </button>
      </div>

      {isOpen && (
        <div className="absolute left-2 right-2 top-full mt-0.5 z-50 bg-popover border border-border rounded-md shadow-md py-1 max-h-[280px] overflow-y-auto">
          <button
            onClick={() => {
              onSelect(null)
              setIsOpen(false)
            }}
            className={cn(
              'w-full text-left px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors',
              !selectedRepo && 'bg-accent/30 font-medium',
            )}
          >
            全部仓库（扫描整个工作区）
          </button>
          {repos.map((repo) => {
            const isSelected = normalizePathKey(repo.repoPath) === normalizePathKey(selectedPath ?? '')
            return (
              <button
                key={repo.repoPath}
                onClick={() => {
                  onSelect(repo)
                  setIsOpen(false)
                }}
                className={cn(
                  'w-full text-left px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors flex items-center gap-2',
                  isSelected && 'bg-accent/30 font-medium',
                )}
              >
                <GitBranch className="w-3 h-3 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{repo.name}</span>
                <span className="text-muted-foreground truncate max-w-[100px]">{repo.branch}</span>
                <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">
                  {repo.worktreeCount} 工作树
                </span>
              </button>
            )
          })}
          {workspaceSlug && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                void handleAddRepo()
              }}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors flex items-center gap-2 text-muted-foreground border-t border-border/40 mt-0.5"
            >
              <Plus className="w-3 h-3 shrink-0" />
              <span>添加仓库…（不在扫描范围内时手动加入）</span>
            </button>
          )}
        </div>
      )}
    </div>
  )

  async function handleAddRepo(): Promise<void> {
    if (!workspaceSlug) return
    const repoPath = await window.electronAPI.selectDirectory()
    if (!repoPath) return
    try {
      await window.electronAPI.addWorktreeRepo(workspaceSlug, {
        name: repoPath.split(/[\\/]/).filter(Boolean).pop() || repoPath,
        repoPath,
        worktreesPath: '',
        priority: 0,
      })
      await fetchRepos(true)
    } catch {
      window.alert('添加仓库失败，请确认路径可访问')
    }
  }
}
