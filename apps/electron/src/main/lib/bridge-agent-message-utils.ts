/**
 * Pi runtime 的 message_update 会用 _partial 标记预览帧。
 * 这些帧通常携带"当前累计全文"，只适合 UI upsert，不应进入 IM Bridge 的最终回复 buffer。
 *
 * 注意：_partial 是 Pi SDK 内部实现字段（非公开契约），如 Pi SDK 版本更新后改变字段名，
 * 此函数会静默返回 false，可能导致 partial 消息被误判为最终消息。
 * 届时需同步更新此处判断。
 */
import type { SDKAssistantMessage, SDKMessage } from '@proma/shared'

export function isPartialSDKMessage(message: SDKMessage): boolean {
  return (message as Record<string, unknown>)._partial === true
}

export function extractFinalAssistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') return ''
  if (isPartialSDKMessage(message)) return ''

  const assistant = message as SDKAssistantMessage
  return (assistant.message?.content ?? [])
    .map((block) => block.type === 'text' && typeof block.text === 'string' ? block.text : '')
    .join('')
}
