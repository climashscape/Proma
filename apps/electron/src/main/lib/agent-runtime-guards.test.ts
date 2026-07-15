/**
 * @fileoverview
 * 测试 Pi Runtime 运行时守卫逻辑。
 * 覆盖：最大轮次、预算限制、结构化输出校验等。
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { Type } from 'typebox'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createAgentRuntimeGuard, appendOutputFormatInstruction } from './agent-runtime-guards'

describe('Agent Runtime Guard', () => {
  describe('createAgentRuntimeGuard', () => {
    it('should track assistant turns correctly', () => {
      const guard = createAgentRuntimeGuard({ maxTurns: 2 })

      const assistantMessage1 = { role: 'assistant', content: [] } as AgentMessage
      const assistantMessage2 = { role: 'assistant', content: [] } as AgentMessage
      const assistantMessage3 = { role: 'assistant', content: [] } as AgentMessage

      guard.recordMessage(assistantMessage1)
      expect(guard.shouldStopBeforeNextTurn()).toBe(false)

      guard.recordMessage(assistantMessage2)
      expect(guard.shouldStopBeforeNextTurn()).toBe(true)

      // 第3个 turn 应该被拒绝
      guard.recordMessage(assistantMessage3)
      expect(guard.shouldStopBeforeNextTurn()).toBe(true)
    })

    it('should respect max budget', () => {
      const guard = createAgentRuntimeGuard({ maxBudgetUsd: 0.01 })

      const assistantMessage1 = {
        role: 'assistant',
        content: [],
        usage: { cost: { total: 0.005 } },
      } as AgentMessage

      const assistantMessage2 = {
        role: 'assistant',
        content: [],
        usage: { cost: { total: 0.006 } },
      } as AgentMessage

      guard.recordMessage(assistantMessage1)
      expect(guard.shouldStopBeforeNextTurn()).toBe(false)

      guard.recordMessage(assistantMessage2)
      expect(guard.shouldStopBeforeNextTurn()).toBe(true)
    })

    it('should validate output format', () => {
      const schema = Type.Object({
        result: Type.String(),
      })

      const guard = createAgentRuntimeGuard({ outputFormat: { schema, name: 'Result' } })

      // 测试空消息数组
      const emptyMessages: AgentMessage[] = []
      const result = guard.getResultOverride(emptyMessages)
      expect(result).toBeUndefined()
    })
  })

  describe('appendOutputFormatInstruction', () => {
    it('should append output format to prompt', () => {
      const prompt = 'Do something'
      const schema = Type.Object({ value: Type.String() })
      const result = appendOutputFormatInstruction(prompt, { schema, name: 'Test' })

      expect(result).toContain('<output_format>')
      expect(result).toContain('Test')
    })
  })
})
