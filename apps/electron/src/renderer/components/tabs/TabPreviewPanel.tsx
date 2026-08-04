/**
 * TabPreviewPanel — Tab 悬浮预览面板
 *
 * 在 Tab hover 时向下弹出，显示：
 * 1. 对话标题
 * 2. 会话流实时运行状态（会话正在流式运行时）：迷你会话流——thinking / 工具调用 / 文本输出
 *    按时间顺序滚动展示，末尾是正在生成的实时内容
 * 3. 消息列表（复用 minimap 风格）
 * 无搜索、无最小条目限制。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AlertTriangle, AlertCircle, Brain, CheckCircle2, Loader2 } from 'lucide-react'
import { UserAvatar } from '@/components/chat/UserAvatar'
import { getModelLogo, resolveModelDisplayName, resolveModelProvider } from '@/lib/model-logo'
import { channelsAtom } from '@/atoms/chat-atoms'
import { cn } from '@/lib/utils'
import { Spinner } from '@/components/ui/spinner'
import { getToolPhrase } from '@/components/agent/tool-phrase'
import { getSDKCompactStatus } from '@proma/shared'
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKSystemMessage,
  SDKContentBlock,
  SDKToolUseBlock,
  SDKUserContentBlock,
} from '@proma/shared'
import type { TabMinimapItem, TabStreamRunData, TabStreamActivity } from '@/atoms/tab-atoms'

interface TabPreviewPanelProps {
  title: string
  items: TabMinimapItem[]
  /** 会话流实时运行数据（流式运行时传入，否则为 null） */
  streamRun?: TabStreamRunData | null
  isLeaving: boolean
}

// ── Markdown 预览配置（轻量级） ──

const PREVIEW_REMARK_PLUGINS = [remarkGfm]

/* eslint-disable @typescript-eslint/no-explicit-any */
const PREVIEW_MD_COMPONENTS = {
  pre: ({ children }: { children?: React.ReactNode }) => <pre className="text-[11px] opacity-70 truncate">{children}</pre>,
  code: ({ children }: { children?: React.ReactNode }) => <code className="text-[11px] bg-muted/50 px-0.5 rounded">{children}</code>,
  img: () => null as unknown as React.ReactElement,
  a: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
} as const
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── 迷你会话流条目 ──

/** 迷你会话流中的单条渲染条目（由 liveMessages + 实时流式状态转换而来） */
interface TabFlowEntry {
  id: string
  type: 'text' | 'thinking' | 'tool' | 'user' | 'status'
  text?: string
  toolName?: string
  input?: Record<string, unknown>
  done?: boolean
  isError?: boolean
  /** 是否属于当前正在生成的实时内容 */
  streaming?: boolean
}

// ── 子组件 ──

function ItemIcon({ item }: { item: TabMinimapItem }): React.ReactElement {
  const channels = useAtomValue(channelsAtom)
  if (item.role === 'user' && item.avatar) {
    return <UserAvatar avatar={item.avatar} size={16} className="mt-0.5" />
  }
  if (item.role === 'assistant' && item.model) {
    return (
      <img
        src={getModelLogo(item.model, resolveModelProvider(item.model, channels))}
        alt=""
        className="size-4 shrink-0 mt-0.5 rounded-[20%] object-cover"
      />
    )
  }
  if (item.role === 'status') {
    return <AlertTriangle className="size-4 shrink-0 mt-0.5 text-destructive" />
  }
  return <div className="size-4 shrink-0 mt-0.5 rounded-[20%] bg-muted" />
}

function PreviewInner({ text }: { text: string }): React.ReactElement {
  if (!text) {
    return <span className="text-xs opacity-40">(空消息)</span>
  }

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none text-xs text-popover-foreground/80 prose-p:my-0 prose-headings:my-0.5 prose-headings:text-xs prose-li:my-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 line-clamp-2 overflow-hidden">
      <Markdown remarkPlugins={PREVIEW_REMARK_PLUGINS} components={PREVIEW_MD_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  )
}

/** memo 化：流式 content 不变时跳过 Markdown 重解析（高频重渲染下收益明显） */
const Preview = React.memo(PreviewInner)

/** 运行耗时计时器 — 从 startedAt 起实时刷新（250ms 节流，足够秒级可读且省资源） */
function StreamRunTimer({ startedAt }: { startedAt?: number }): React.ReactElement {
  const [elapsed, setElapsed] = React.useState(0)

  React.useEffect(() => {
    const start = startedAt ?? Date.now()
    const update = (): void => setElapsed((Date.now() - start) / 1000)
    update()
    const timer = setInterval(update, 250)
    return () => clearInterval(timer)
  }, [startedAt])

  const formatTime = (seconds: number): string => {
    if (seconds < 60) return `${seconds.toFixed(1)}s`
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}m ${s.toFixed(0)}s`
  }

  return <span className="tabular-nums">{formatTime(elapsed)}</span>
}

/** 单条工具活动行 — 运行中/完成/出错三种状态 */
function StreamActivityRow({ activity }: { activity: TabStreamActivity }): React.ReactElement {
  const phrase = getToolPhrase(activity.toolName, activity.input)
  const label = activity.done ? phrase.label : (phrase.loadingLabel || `正在${phrase.label}...`)

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {activity.done ? (
        activity.isError
          ? <AlertCircle className="size-3 shrink-0 text-destructive" />
          : <CheckCircle2 className="size-3 shrink-0 text-emerald-500/80" />
      ) : (
        <Loader2 className="size-3 shrink-0 animate-spin text-primary/70" />
      )}
      <span className="truncate text-[11px] text-popover-foreground/75">{label}</span>
    </div>
  )
}

/** 迷你会话流单条渲染 */
function FlowEntry({ entry }: { entry: TabFlowEntry }): React.ReactElement {
  if (entry.type === 'tool') {
    return (
      <StreamActivityRow
        activity={{
          id: entry.id,
          toolName: entry.toolName ?? 'tool',
          input: entry.input ?? {},
          done: entry.done ?? false,
          isError: entry.isError,
        }}
      />
    )
  }

  if (entry.type === 'thinking') {
    return (
      <div className="rounded-md border border-border/40 bg-muted/20 px-2 py-1">
        <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground/60 mb-0.5">
          <Brain className="size-2.5" />
          Thinking
        </div>
        <div className="text-[11px] leading-4 text-popover-foreground/60 line-clamp-2 overflow-hidden whitespace-pre-wrap break-words">
          {entry.text}
        </div>
      </div>
    )
  }

  if (entry.type === 'user') {
    return (
      <div className="rounded-md bg-primary/[0.06] px-2 py-1">
        <div className="text-[11px] leading-4 text-popover-foreground/85 line-clamp-2 overflow-hidden whitespace-pre-wrap break-words">
          {entry.text}
        </div>
      </div>
    )
  }

  if (entry.type === 'status') {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-amber-600/80 dark:text-amber-400/80">
        <AlertTriangle className="size-3 shrink-0" />
        {entry.text}
      </div>
    )
  }

  // text
  return (
    <div className={cn(
      'rounded-md',
      entry.streaming ? 'bg-background/60 border border-border/40 px-1.5 py-1' : 'px-1 py-0.5',
    )}>
      <Preview text={entry.text ?? ''} />
    </div>
  )
}

// ── 迷你会话流数据转换 ──

/** 从 SDKMessage 块中提取文本（与 SessionMiniMapPopover 语义一致） */
function blockText(block: SDKContentBlock | SDKUserContentBlock): string {
  if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
    return block.text
  }
  if (block.type === 'thinking' && 'thinking' in block && typeof block.thinking === 'string') {
    return block.thinking
  }
  return ''
}

/** Agent：把实时 SDKMessage 流转换为按时间顺序的流条目 */
function buildAgentFlowEntries(
  liveMessages: SDKMessage[] | undefined,
  content: string,
  activities: TabStreamActivity[],
): TabFlowEntry[] {
  const entries: TabFlowEntry[] = []

  for (const message of liveMessages ?? []) {
    if (message.type === 'assistant') {
      const assistant = message as SDKAssistantMessage
      const blocks = Array.isArray(assistant.message?.content) ? assistant.message.content : []
      const baseId = assistant.uuid ?? `assistant-${entries.length}`
      blocks.forEach((block, blockIndex) => {
        if (block.type === 'tool_use') {
          const tb = block as SDKToolUseBlock
          entries.push({
            id: tb.id,
            type: 'tool',
            toolName: tb.name,
            input: (tb.input ?? {}) as Record<string, unknown>,
            done: false,
          })
          return
        }
        const text = blockText(block).trim()
        if (!text) return
        entries.push({
          id: `${baseId}-${blockIndex}`,
          type: block.type === 'thinking' ? 'thinking' : 'text',
          text,
        })
      })
      continue
    }

    if (message.type === 'user') {
      const user = message as SDKUserMessage
      const blocks = Array.isArray(user.message?.content) ? user.message.content : []
      // tool_result 块是工具调用的回执（工具行已表达），过滤后提取同一消息里的用户文本
      const text = blocks
        .filter((b) => b.type !== 'tool_result')
        .map(blockText)
        .filter(Boolean)
        .join('\n')
        .trim()
      if (!text) continue
      entries.push({
        id: user.uuid ?? `user-${entries.length}`,
        type: 'user',
        text,
      })
      continue
    }

    if (message.type === 'system') {
      const system = message as SDKSystemMessage
      const compactStatus = getSDKCompactStatus(system)
      const statusText = compactStatus === 'success' ? '上下文已压缩'
        : compactStatus === 'compacting' ? '正在压缩上下文...'
        : compactStatus === 'failed' ? '上下文压缩失败'
        : compactStatus === 'noop' ? '当前上下文无需压缩'
        : system.subtype === 'permission_denied' ? '权限检查已拒绝操作'
        : ''
      if (statusText) {
        // SDKSystemMessage 无 uuid，用索引作稳定 id
        entries.push({ id: `system-${entries.length}`, type: 'status', text: statusText })
      }
    }
  }

  // 用 streamState 活动回填/补充工具条目：
  // - 已出现在 liveMessages 的 tool_use 条目用活动状态回填完成/错误态（tool_result 消息不进入流条目）
  // - 尚未出现（tool_start 先于 SDKMessage 到达）且进行中的活动才追加
  for (const activity of activities) {
    const idx = entries.findIndex((e) => e.id === activity.id && e.type === 'tool')
    if (idx >= 0) {
      if (activity.done) {
        entries[idx] = { ...entries[idx]!, done: true, isError: activity.isError }
      }
    } else if (!activity.done) {
      entries.push({ ...activity, type: 'tool', streaming: true })
    }
  }

  // 实时文本：固定 id 的 live 条目追加在流末尾（绝不覆盖已完成的历史 text 块）。
  // 若 SDK 已把最后一条 text 块 partial 更新到与 content 相同则跳过，避免重复。
  const trimmedContent = content.trim()
  if (trimmedContent) {
    const liveIdx = entries.findIndex((e) => e.id === 'live-text')
    if (liveIdx >= 0) {
      entries[liveIdx] = { ...entries[liveIdx]!, text: content, streaming: true }
    } else {
      const lastEntry = entries[entries.length - 1]
      const alreadyLive = lastEntry?.type === 'text' && lastEntry.text === content
      if (!alreadyLive) {
        entries.push({ id: 'live-text', type: 'text', text: content, streaming: true })
      }
    }
  }

  return entries
}

/** Chat：由 reasoning / toolActivities / content 组成同类流 */
function buildChatFlowEntries(data: TabStreamRunData): TabFlowEntry[] {
  const entries: TabFlowEntry[] = []

  if (data.reasoning && data.reasoning.trim()) {
    entries.push({ id: 'chat-reasoning', type: 'thinking', text: data.reasoning.trim() })
  }

  for (const activity of data.activities) {
    entries.push({ ...activity, type: 'tool' })
  }

  if (data.content && data.content.trim()) {
    entries.push({ id: 'chat-content', type: 'text', text: data.content, streaming: true })
  }

  return entries
}

/** 统一的流条目构建入口 */
function buildFlowEntries(data: TabStreamRunData): TabFlowEntry[] {
  if (data.kind === 'agent') {
    return buildAgentFlowEntries(data.liveMessages, data.content, data.activities)
  }
  return buildChatFlowEntries(data)
}

// ── 主组件 ──

/** 会话流实时运行区域 — 运行指示 + 迷你会话流（自动滚动） */
function StreamRunSection({ streamRun }: { streamRun: TabStreamRunData }): React.ReactElement {
  const channels = useAtomValue(channelsAtom)
  const modelName = streamRun.model
    ? resolveModelDisplayName(streamRun.model, channels)
    : undefined
  const flowEntries = React.useMemo(() => buildFlowEntries(streamRun), [streamRun])
  const scrollRef = React.useRef<HTMLDivElement>(null)

  // 实时流自动滚动：仅当用户接近底部时才贴底，避免劫持 hover 阅读
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [flowEntries])

  return (
    <div className="shrink-0 border-b border-border/60 bg-muted/20 flex flex-col">
      {/* 运行指示条 */}
      <div className="flex items-center gap-2 px-3 py-2">
        <Spinner size="sm" className="text-primary/70 shrink-0" />
        <span className="text-[11px] font-medium text-popover-foreground/85 truncate">
          {streamRun.kind === 'agent' ? 'Agent 运行中' : 'Chat 生成中'}
        </span>
        <StreamRunTimer startedAt={streamRun.startedAt} />
        {modelName && (
          <span className="shrink-0 ml-auto text-[10px] text-muted-foreground/80 truncate max-w-[96px]">
            {modelName}
          </span>
        )}
      </div>

      {/* 迷你会话流 */}
      {flowEntries.length > 0 && (
        <div
          ref={scrollRef}
          className="max-h-[220px] overflow-y-auto px-2 pb-2 space-y-1 scrollbar-thin"
        >
          {flowEntries.map((entry) => (
            <FlowEntry key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}

export function TabPreviewPanel({ title, items, streamRun, isLeaving }: TabPreviewPanelProps): React.ReactElement {
  return (
    <div
      className={cn(
        'w-[280px] rounded-lg border bg-popover shadow-xl origin-top flex flex-col overflow-hidden',
        isLeaving
          ? 'animate-out fade-out-0 zoom-out-95 duration-75'
          : 'animate-in fade-in-0 zoom-in-95 duration-150'
      )}
      style={{ maxHeight: 'min(420px, 60vh)' }}
    >
      {/* 标题栏 */}
      <div className="relative z-10 flex items-center justify-between px-3 py-2 border-b shrink-0 bg-popover">
        <span className="text-xs font-medium text-popover-foreground/90 truncate flex-1 min-w-0">
          {title}
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums ml-2 shrink-0">
          {streamRun ? '● 实时' : items.length}
        </span>
      </div>

      {/* 会话流实时运行区域（流式运行时显示；此时不渲染下方消息列表，避免两段重复） */}
      {streamRun && <StreamRunSection streamRun={streamRun} />}

      {/* 消息列表（仅非流式运行时显示） */}
      {!streamRun && (
        <div className="overflow-y-auto flex-1 p-1.5 space-y-0.5 scrollbar-thin">
          {items.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              暂无消息
            </div>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-2 w-full rounded-md px-2 py-1.5 text-left"
              >
                <ItemIcon item={item} />
                <div className="flex-1 min-w-0">
                  <Preview text={item.preview} />
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
