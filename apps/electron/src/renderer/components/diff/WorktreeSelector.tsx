import * as React from 'react'
import { GitBranch, ChevronDown, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorktreeInfo } from '@proma/shared'

interface WorktreeSelectorProps {
  sessionId: string
  /** 当前选中的仓库根路径（仅列出该仓库的 worktree） */
  repoPath: string
  /** 当前选中的 worktree 路径，null = 聚合视图（全部工作树） */
  selectedPath: string | null
  onSelect: (worktree: WorktreeInfo | null) => void
  /** 当前对比基准分支（空 = 自动探测） */
  baseBranch?: string
  onBaseBranchChange?: (base: string | null) => void
}

/**
 * Worktree 过滤条 — 在仓库聚合视图内细看单个 worktree。
 *
 * 仅当选中某个仓库后显示；「全部工作树」回到聚合视图，
 * 选中某个 worktree 则只展示该 worktree 相对基准分支的变更。
 */
export function WorktreeSelector({
  sessionId,
  repoPath,
  selectedPath,
  onSelect,
  baseBranch,
  onBaseBranchChange,
}: WorktreeSelectorProps): React.ReactElement {
  const [worktrees, setWorktrees] = React.useState<WorktreeInfo[]>([])
  const [isOpen, setIsOpen] = React.useState(false)
  const [isLoading, setIsLoading] = React.useState(false)
  const dropdownRef = React.useRef<HTMLDivElement>(null)

  const fetchWorktrees = React.useCallback(async (force = false) => {
    setIsLoading(true)
    try {
      const list = await window.electronAPI.listWorktrees(repoPath, sessionId, force)
      setWorktrees(list)
    } catch {
      setWorktrees([])
    } finally {
      setIsLoading(false)
    }
  }, [repoPath, sessionId])

  React.useEffect(() => {
    fetchWorktrees()
  }, [fetchWorktrees])

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

  if (worktrees.length === 0 && !isLoading) return <></>

  const selectedWorktree = worktrees.find((wt) => wt.path === selectedPath) ?? null
  const displayLabel = selectedWorktree
    ? (baseBranch ? `${selectedWorktree.branch} vs ${baseBranch}` : selectedWorktree.branch)
    : '全部工作树'
  // 对比基准候选：本仓库其他 worktree 的分支
  const baseCandidates = selectedWorktree
    ? worktrees.filter((wt) => wt.path !== selectedWorktree.path && wt.branch !== 'unknown')
    : []

  return (
    <div ref={dropdownRef} className="relative px-3 py-1 border-b border-border/50 bg-muted/10">
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          aria-label="选择工作树"
          className={cn(
            'flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px]',
            'hover:bg-accent/50 transition-colors',
            'text-muted-foreground hover:text-foreground',
            selectedWorktree && 'text-foreground font-medium',
          )}
        >
          <GitBranch className="w-3 h-3 shrink-0" />
          <span className="truncate max-w-[160px]">{displayLabel}</span>
          <ChevronDown className={cn('w-3 h-3 shrink-0 transition-transform', isOpen && 'rotate-180')} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            fetchWorktrees(true)
          }}
          aria-label="刷新工作树列表"
          className="p-0.5 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
          title="刷新工作树列表"
        >
          <RefreshCw className={cn('w-3 h-3', isLoading && 'animate-spin')} />
        </button>
      </div>

      {isOpen && (
        <div className="absolute left-2 right-2 top-full mt-0.5 z-50 bg-popover border border-border rounded-md shadow-md py-1 max-h-[240px] overflow-y-auto">
          <button
            onClick={() => {
              onSelect(null)
              setIsOpen(false)
            }}
            className={cn(
              'w-full text-left px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors',
              !selectedWorktree && 'bg-accent/30 font-medium',
            )}
          >
            全部工作树（聚合视图）
          </button>
          {worktrees.map((wt) => (
            <button
              key={wt.path}
              onClick={() => {
                onSelect(wt)
                setIsOpen(false)
              }}
              className={cn(
                'w-full text-left px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors flex items-center gap-2',
                selectedPath === wt.path && 'bg-accent/30 font-medium',
              )}
            >
              <GitBranch className="w-3 h-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{wt.branch}</span>
              {wt.isMain && <span className="text-[10px] px-1 rounded bg-muted text-muted-foreground shrink-0">main</span>}
              <span className="text-muted-foreground ml-auto shrink-0">{wt.head}</span>
            </button>
          ))}
          {/* 对比基准：选中单个 worktree 后可选对比目标（worktree A vs B） */}
          {selectedWorktree && baseCandidates.length > 0 && (
            <>
              <div className="px-3 pt-2 pb-0.5 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">
                对比基准
              </div>
              <button
                onClick={() => {
                  onBaseBranchChange?.(null)
                  setIsOpen(false)
                }}
                className={cn(
                  'w-full text-left px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors',
                  !baseBranch && 'bg-accent/30 font-medium',
                )}
              >
                默认（自动探测主分支）
              </button>
              {baseCandidates.map((wt) => (
                <button
                  key={`base:${wt.path}`}
                  onClick={() => {
                    onBaseBranchChange?.(wt.branch)
                    setIsOpen(false)
                  }}
                  className={cn(
                    'w-full text-left px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors flex items-center gap-2',
                    baseBranch === wt.branch && 'bg-accent/30 font-medium',
                  )}
                >
                  <span className="truncate">{wt.branch}</span>
                  <span className="text-muted-foreground ml-auto shrink-0">对比此分支</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
