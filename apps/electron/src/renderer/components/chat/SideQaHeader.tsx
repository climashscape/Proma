/**
 * SideQaHeader — 右侧问答窄面板的精简头部
 *
 * 问答模式（ChatView variant="side-qa"）专用头部：
 * - 仅显示标题 + 来源标注副标题
 * - 裁剪主 Tab 头部的标题编辑 / 置顶 / 并排 / SystemPromptSelector / titlebar-drag-region
 * - 来源标注从对话元数据读取 sourceKind / sourceLabel / sourceRef：
 *   有 sourceLabel 时优先展示（各入口已写入如「Agent 历史消息」「文件名」），
 *   缺省时按 sourceKind 生成默认文案；side-panel（右侧面板直接新建）或无来源不显示
 */

import * as React from 'react'
import type { ConversationMeta } from '@proma/shared'

/** 从文件名/路径中取 basename（与 SidePanel 的 getPathBasename 一致） */
function getPathBasename(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath
}

/** 构建来源标注文案；无来源返回 null（不展示） */
export function buildSourceCaption(conversation: ConversationMeta): string | null {
  if (!conversation.sourceKind || conversation.sourceKind === 'side-panel') return null

  // 优先使用入口写入的展示标签
  if (conversation.sourceLabel) return `来自 ${conversation.sourceLabel}`

  switch (conversation.sourceKind) {
    case 'agent-history':
      return '来自 Agent 历史消息'
    case 'file':
      return conversation.sourceRef ? `来自 ${getPathBasename(conversation.sourceRef)}` : '来自文件'
    case 'scratch-pad':
      return '来自草稿页'
    default:
      return null
  }
}

interface SideQaHeaderProps {
  conversation: ConversationMeta | null
}

export function SideQaHeader({ conversation }: SideQaHeaderProps): React.ReactElement | null {
  if (!conversation) return null

  const sourceCaption = buildSourceCaption(conversation)

  return (
    <div className="relative flex flex-col justify-center min-w-0 px-3 h-[48px] flex-shrink-0 select-none">
      {/* 拖拽层：右侧问答头部整体可拖拽移动窗口（与 ChatHeader 一致，无按钮故无需 titlebar-no-drag 隔离） */}
      <div className="absolute inset-0 titlebar-drag-region pointer-events-none" />
      <span className="truncate text-sm font-medium text-foreground">
        {conversation.title}
      </span>
      {sourceCaption && (
        <span className="truncate text-[11px] leading-4 text-muted-foreground">
          {sourceCaption}
        </span>
      )}
    </div>
  )
}
