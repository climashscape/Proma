/**
 * ExperimentalSettings - 实验性功能设置页
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { agentRuntimeAtom, experimentalAgentRuntimeSwitchEnabledAtom } from '@/atoms/agent-atoms'
import { SettingsCard, SettingsRow, SettingsSection } from './primitives'
import type { AgentRuntime } from '@proma/shared'

export function ExperimentalSettings(): React.ReactElement {
  const [experimentalRuntimeSwitchEnabled, setExperimentalRuntimeSwitchEnabled] = useAtom(experimentalAgentRuntimeSwitchEnabledAtom)
  const [agentRuntime, setAgentRuntime] = useAtom(agentRuntimeAtom)
  const [pendingRuntime, setPendingRuntime] = React.useState<AgentRuntime | null>(null)

  const handleRuntimeChange = async (runtime: AgentRuntime): Promise<void> => {
    if (!experimentalRuntimeSwitchEnabled && runtime !== 'claude') return

    // 切换到 Pi 时弹出二次确认
    if (runtime === 'pi') {
      setPendingRuntime('pi')
      return
    }

    const previousRuntime = agentRuntime
    setAgentRuntime(runtime)
    try {
      await window.electronAPI.updateSettings({ agentRuntime: runtime })
    } catch (error) {
      console.error('[ExperimentalSettings] 保存默认 Runtime 失败:', error)
      setAgentRuntime(previousRuntime)
    }
  }

  const confirmRuntimeSwitch = async (): Promise<void> => {
    if (!pendingRuntime) return
    setPendingRuntime(null)
    const previousRuntime = agentRuntime
    setAgentRuntime(pendingRuntime)
    try {
      await window.electronAPI.updateSettings({ agentRuntime: pendingRuntime })
    } catch (error) {
      console.error('[ExperimentalSettings] 保存默认 Runtime 失败:', error)
      setAgentRuntime(previousRuntime)
    }
  }

  const handleExperimentalRuntimeSwitchChange = async (enabled: boolean): Promise<void> => {
    const previousEnabled = experimentalRuntimeSwitchEnabled
    const previousRuntime = agentRuntime
    setExperimentalRuntimeSwitchEnabled(enabled)
    if (!enabled) {
      setAgentRuntime('claude')
    }
    const updates: Parameters<typeof window.electronAPI.updateSettings>[0] = {
      experimentalAgentRuntimeSwitchEnabled: enabled,
    }
    if (!enabled) {
      updates.agentRuntime = 'claude'
    }
    try {
      await window.electronAPI.updateSettings(updates)
    } catch (error) {
      console.error('[ExperimentalSettings] 保存实验性开关失败:', error)
      // 回滚前端状态
      setExperimentalRuntimeSwitchEnabled(previousEnabled)
      if (!enabled) {
        setAgentRuntime(previousRuntime)
      }
    }
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        title="实验性功能"
        description="这些能力仍在验证中，默认关闭。"
      >
        <SettingsCard>
          <SettingsRow
            label="Agent 内核切换"
            description="开启后可在 Agent 输入框下方切换 Claude / Pi；关闭时始终使用 Claude Agent SDK"
          >
            <Switch
              checked={experimentalRuntimeSwitchEnabled}
              onCheckedChange={handleExperimentalRuntimeSwitchChange}
            />
          </SettingsRow>
          {experimentalRuntimeSwitchEnabled && (
            <SettingsRow
              label="默认 Agent Runtime"
              description="选择新 Agent 会话默认使用的底层 runtime；当前会话也可在 Agent 输入框下方切换"
            >
              <div className="flex items-center rounded-lg bg-muted p-1">
                <Button
                  type="button"
                  size="sm"
                  variant={agentRuntime === 'claude' ? 'default' : 'ghost'}
                  className="h-7 px-3 text-xs"
                  onClick={() => handleRuntimeChange('claude')}
                >
                  Claude SDK
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={agentRuntime === 'pi' ? 'default' : 'ghost'}
                  className="h-7 px-3 text-xs"
                  onClick={() => handleRuntimeChange('pi')}
                >
                  Pi SDK
                </Button>
              </div>
            </SettingsRow>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* 切换到 Pi 的二次确认弹窗 */}
      <AlertDialog open={pendingRuntime === 'pi'} onOpenChange={(open) => { if (!open) setPendingRuntime(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>切换到 Pi Agent SDK</AlertDialogTitle>
            <AlertDialogDescription>
              切换后新 Agent 会话将使用 Pi Agent SDK 作为底层运行时。部分内置 MCP 的行为可能有所不同。
              当前会话不受影响，你也可以在 Agent 输入框下方随时切换回来。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingRuntime(null)}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRuntimeSwitch}>确认切换</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}