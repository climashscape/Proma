/**
 * useOpenSideChat — 统一的「新建右侧问答会话」操作
 *
 * 问答 Tab 重构（波 A）：Agent 历史选区 / 预览选区 / 草稿选区 / 侧边面板
 * 四个新建入口共用同一条创建链路，保证：
 * - sourceType='agent-side-qa' + parentAgentSessionId 持久化，问答会话归属当前 Agent 会话
 * - 模型/渠道继承 Agent 会话（agentSessionModelMapAtom / agentSessionChannelMapAtom），
 *   而非 Chat 全局选中模型（selectedModelAtom）
 * - 来源标注（sourceKind / sourceRef / sourceLabel）写入会话元数据
 * - 首问引用持久化到 seedSelection（追问延续基础），同时兼容写 quotedSelectionMap
 *   供现有 ChatView 发送链路消费（波 B 再统一为只读 seedSelection）
 * - agentSideChatMap 绑定 + 打开右侧面板并切到 chat Tab
 */

import * as React from 'react'
import { useSetAtom, useStore } from 'jotai'
import { toast } from 'sonner'
import {
  agentSideChatMapAtom,
  conversationsAtom,
  conversationDraftsAtom,
  selectedModelAtom,
} from '@/atoms/chat-atoms'
import {
  agentDiffPanelTabAtom,
  agentSessionChannelMapAtom,
  agentSessionModelMapAtom,
  agentSidePanelOpenAtom,
  currentAgentSessionIdAtom,
} from '@/atoms/agent-atoms'
import { quotedSelectionMapAtom, type QuotedSelection, type QuotedSelectionSourceType } from '@/atoms/preview-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import type { ConversationMeta } from '@proma/shared'

/** 首问引用种子（与 quotedSelectionMap 兼容的子集） */
export interface SideChatSeed {
  text: string
  sourceType: QuotedSelectionSourceType
  sourceLabel?: string
  filePath?: string
  messageId?: string
  messageRole?: QuotedSelection['messageRole']
}

export interface OpenSideChatOptions {
  /** 新建对话标题（如「历史选区问答」「右侧问答」） */
  title: string
  /** 首问选区来源类型 */
  sourceKind: ConversationMeta['sourceKind']
  /**
   * 来源引用（messageId / filePath）。
   * 缺省时由 seed 自动推导：seed.messageId ?? seed.filePath
   */
  sourceRef?: string
  /** 来源展示标签（列表与元数据展示；缺省时回退 seed.sourceLabel） */
  sourceLabel?: string
  /** 新建后预填的输入框草稿；null 表示不预填（默认「我的问题：」） */
  draft?: string | null
  /** 草稿选区等入口需要：打开右侧面板时同步切到 Agent 模式 */
  switchToAgentMode?: boolean
  /** 失败日志前缀 */
  errorLogPrefix?: string
}

type OpenSideChatFn = (sessionId: string, seed: SideChatSeed | null) => Promise<boolean>

export function useOpenSideChat(options: OpenSideChatOptions): OpenSideChatFn {
  const store = useStore()
  const setConversations = useSetAtom(conversationsAtom)
  const setConversationDrafts = useSetAtom(conversationDraftsAtom)
  const setQuotedSelectionMap = useSetAtom(quotedSelectionMapAtom)
  const setSideChatMap = useSetAtom(agentSideChatMapAtom)
  const setSidePanelOpen = useSetAtom(agentSidePanelOpenAtom)
  const setSidePanelTabMap = useSetAtom(agentDiffPanelTabAtom)
  const setCurrentAgentSessionId = useSetAtom(currentAgentSessionIdAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const pendingRef = React.useRef(false)

  const {
    title,
    sourceKind,
    sourceRef,
    sourceLabel,
    draft = '我的问题：',
    switchToAgentMode = false,
    errorLogPrefix = 'useOpenSideChat',
  } = options

  return React.useCallback(
    async (sessionId: string, seed: SideChatSeed | null): Promise<boolean> => {
      if (!sessionId || pendingRef.current) return false
      pendingRef.current = true
      try {
        // 模型继承：读 Agent 会话自己的模型/渠道（而非 Chat 全局选中模型）
        // 取不到时回退 Chat 全局选中模型（selectedModelAtom 的 modelId/channelId，
        // 无独立渠道 atom，渠道是 SelectedModel 的字段），避免静默无模型创建。
        const fallbackModel = store.get(selectedModelAtom)
        const modelId = store.get(agentSessionModelMapAtom).get(sessionId) ?? fallbackModel?.modelId ?? undefined
        const channelId = store.get(agentSessionChannelMapAtom).get(sessionId) ?? fallbackModel?.channelId ?? undefined

        // 首问引用持久化到 seedSelection（追问延续基础）
        const seedSelection: ConversationMeta['seedSelection'] = seed
          ? {
              text: seed.text,
              sourceType: seed.sourceType,
              sourceLabel: seed.sourceLabel,
              filePath: seed.filePath,
              messageId: seed.messageId,
              messageRole: seed.messageRole,
            }
          : undefined

        const conversation = await window.electronAPI.createConversation(
          title,
          modelId,
          channelId,
          'agent-side-qa',
          sessionId,
          sourceKind,
          // sourceRef 是展示用引用标识（列表/头部的来源引用文本）：
          // 缺省时按 messageId → filePath 推导，仍无来源时回退 seed.sourceLabel 作为展示兜底
          sourceRef ?? seed?.messageId ?? seed?.filePath ?? seed?.sourceLabel,
          sourceLabel ?? seed?.sourceLabel,
          seedSelection,
        )

        // 前置插入对话列表
        setConversations((prev) => {
          if (prev.some((item) => item.id === conversation.id)) return prev
          return [conversation, ...prev]
        })

        // 预填输入框草稿（null 表示不预填）
        if (draft !== null) {
          setConversationDrafts((prev) => {
            const next = new Map(prev)
            next.set(conversation.id, draft)
            return next
          })
        }

        // 兼容写 quotedSelectionMap，供现有 ChatView 发送链路消费（波 B 统一为读 seedSelection）
        if (seed) {
          setQuotedSelectionMap((prev) => {
            const next = new Map(prev)
            next.set(conversation.id, {
              text: seed.text,
              filePath: seed.filePath ?? seed.sourceLabel ?? '',
              sourceType: seed.sourceType,
              sourceLabel: seed.sourceLabel,
              messageId: seed.messageId,
              messageRole: seed.messageRole,
              capturedAt: Date.now(),
            })
            return next
          })
        }

        // 绑定为当前 Agent 会话的侧边问答
        setSideChatMap((prev) => {
          const next = new Map(prev)
          next.set(sessionId, conversation.id)
          return next
        })

        // 打开右侧面板并切到 chat Tab
        setSidePanelOpen(true)
        setSidePanelTabMap((prev) => {
          const next = new Map(prev)
          next.set(sessionId, 'chat')
          return next
        })

        // 草稿选区等入口需要切回 Agent 模式
        if (switchToAgentMode) {
          setCurrentAgentSessionId(sessionId)
          setAppMode('agent')
        }

        return true
      } catch (error) {
        console.error(`[${errorLogPrefix}] 新建右侧问答会话失败:`, error)
        toast.error('新建问答对话失败')
        return false
      } finally {
        pendingRef.current = false
      }
    },
    [
      store,
      setConversations,
      setConversationDrafts,
      setQuotedSelectionMap,
      setSideChatMap,
      setSidePanelOpen,
      setSidePanelTabMap,
      setCurrentAgentSessionId,
      setAppMode,
      title,
      sourceKind,
      sourceRef,
      sourceLabel,
      draft,
      switchToAgentMode,
      errorLogPrefix,
    ],
  )
}
