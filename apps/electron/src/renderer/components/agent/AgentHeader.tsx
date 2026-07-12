/**
 * AgentHeader — Agent 会话头部
 *
 * 显示会话标题（可点击编辑）。
 * 参照 ChatHeader 的编辑模式。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Pencil, Check, X, Sparkles, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { tabsAtom, updateTabTitle } from '@/atoms/tab-atoms'
import { replaceAgentSessionInFreshnessOrder } from '@/lib/agent-session-list'
import { detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'
import { cn } from '@/lib/utils'

/** AgentHeader 属性接口 */
interface AgentHeaderProps {
  sessionId: string
}

export function AgentHeader({ sessionId }: AgentHeaderProps): React.ReactElement | null {
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const sessions = useAtomValue(agentSessionsAtom)
  const session = sessions.find((s) => s.id === sessionId) ?? null
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const [editing, setEditing] = React.useState(false)
  const [editTitle, setEditTitle] = React.useState('')
  const [regenerating, setRegenerating] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  if (!session) return null

  // 仅普通主会话（排除协作子会话/定时会话）才显示重生成按钮；
  // 与 orchestrator.regenerateTitle 的会话类型闸门对齐，避免按钮出现却秒退 null。
  const isPlainMainSession =
    !session.parentSessionId &&
    !session.sourceDelegationId &&
    !session.delegationDepth &&
    !session.sourceAutomationId

  /** 进入编辑模式 */
  const startEdit = (): void => {
    setEditTitle(session.title)
    setEditing(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  /** 手动重新生成标题（基于最近消息摘要，跳过节流） */
  const regenerateTitle = async (): Promise<void> => {
    if (regenerating) return
    const previousTitle = session.title  // 保存旧标题用于 undo
    setRegenerating(true)
    try {
      const result = await window.electronAPI.regenerateAgentTitle(session.id)
      if (result.ok && result.title) {
        // 标题更新由全局 onAgentTitleUpdated 监听（useGlobalAgentListeners）统一同步
        // tabs / agentSessions / 侧边栏均由该监听刷新，这里不手动更新避免竞态
        toast.success(`标题已更新：${result.title}`, {
          action: {
            label: '撤销',
            onClick: async () => {
              try {
                // 撤销：写回原标题，同时置 titleManualOverride=true 停止自动漂移覆盖
                const restored = await window.electronAPI.updateAgentSessionTitle(session.id, previousTitle)
                setTabs((prev) => updateTabTitle(prev, restored.id, restored.title))
                setAgentSessions((prev) => replaceAgentSessionInFreshnessOrder(prev, restored))
                toast.success(`已撤销：${previousTitle}`)
              } catch (err) {
                console.error('[AgentHeader] 撤销标题失败:', err)
                toast.error('撤销失败，请手动编辑标题')
              }
            },
          },
        })
        return
      }
      // 按 reason 给准确提示，不再一刀切"未偏离"
      switch (result.reason) {
        case 'no-model':
          toast.error('未配置标题模型，请在设置中绑定渠道与模型，或在该会话发送一条消息后重试')
          break
        case 'no-messages':
          toast.warning('当前会话没有可参考的对话内容')
          break
        case 'not-main-session':
          toast.warning('该会话类型不支持重新生成标题')
          break
        case 'same':
          toast.warning('AI 无法生成有效标题，请手动编辑')
          break
        case 'stale':
          toast('标题刚刚已被自动更新，请再次点击重试')
          break
        default:
          toast.error('重新生成标题失败')
          break
      }
    } catch (error) {
      console.error('[AgentHeader] 重新生成标题失败:', error)
      toast.error('重新生成标题失败')
    } finally {
      setRegenerating(false)
    }
  }

  /** 保存标题 */
  const saveTitle = async (): Promise<void> => {
    const trimmed = editTitle.trim()
    if (!trimmed || trimmed === session.title) {
      setEditing(false)
      return
    }

    try {
      const updated = await window.electronAPI.updateAgentSessionTitle(session.id, trimmed)
      // 同步更新标签页标题
      setTabs((prev) => updateTabTitle(prev, updated.id, updated.title))
      // 同步更新侧边栏会话列表
      setAgentSessions((prev) => replaceAgentSessionInFreshnessOrder(prev, updated))
    } catch (error) {
      console.error('[AgentHeader] 更新标题失败:', error)
    }
    setEditing(false)
  }

  /** 键盘事件 */
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveTitle()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  return (
    <div className="relative z-[51] flex items-center gap-2 px-4 h-[48px]">
      {/* 拖拽层覆盖整行（Windows 避开右上角 WindowControls ~126px），编辑/标题按钮内部已自带 titlebar-no-drag。 */}
      <div className={cn("absolute inset-0 titlebar-drag-region pointer-events-none", isWindows && WINDOW_CONTROLS_INSET_RIGHT)} />
      {editing ? (
        <div className="flex items-center gap-1.5 flex-1 min-w-0 titlebar-no-drag">
          <input
            ref={inputRef}
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={saveTitle}
            className="flex-1 bg-transparent text-sm font-medium border-b border-primary/50 outline-none px-0 py-0.5 min-w-0"
            maxLength={100}
          />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={saveTitle}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Check className="size-3.5" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEditing(false)}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="truncate text-sm font-medium text-foreground">
            {session.title}
          </span>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={startEdit}
            className="titlebar-no-drag p-1 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="编辑标题"
          >
            <Pencil className="size-3.5" />
          </button>
          {isPlainMainSession && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={regenerateTitle}
              disabled={regenerating}
              className="titlebar-no-drag p-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              aria-label="重新生成标题"
              title="基于最近对话重新生成标题"
            >
              {regenerating
                ? <Loader2 className="size-3.5 animate-spin" />
                : <Sparkles className="size-3.5" />}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
