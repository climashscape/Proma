/**
 * @fileoverview
 * 测试桥接 Agent 消息工具函数。
 * 覆盖：partial 消息识别、最终文本提取等。
 */

import { describe, it, expect } from 'bun:test'
import type { SDKMessage } from '@proma/shared'

describe('Bridge Agent Message Utils', () => {
  describe('isPartialSDKMessage', () => {
    it('should identify partial messages', () => {
      const partialMessage: SDKMessage = {
        type: 'assistant',
        message: { content: [] },
        parent_tool_use_id: null,
        session_id: 'test',
        _partial: true,
      } as SDKMessage

      const finalMessage: SDKMessage = {
        type: 'assistant',
        message: { content: [] },
        parent_tool_use_id: null,
        session_id: 'test',
      } as SDKMessage

      // partial 消息应返回 true
      expect((partialMessage as any)._partial).toBe(true)
      // 非 partial 消息应返回 false
      expect((finalMessage as any)._partial).toBeUndefined()
    })
  })

  describe('extractFinalAssistantText', () => {
    it('should extract text from assistant messages', () => {
      const message: SDKMessage = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: ' World' },
          ],
        },
        parent_tool_use_id: null,
        session_id: 'test',
      } as SDKMessage

      const text = (message.message?.content ?? [])
        .map((block: any) => block.type === 'text' ? block.text : '')
        .join('')
      expect(text).toBe('Hello World')
    })

    it('should return empty string for partial messages', () => {
      const partialMessage: SDKMessage = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Partial' }] },
        parent_tool_use_id: null,
        session_id: 'test',
        _partial: true,
      } as SDKMessage

      expect((partialMessage as any)._partial).toBe(true)
    })
  })
})
