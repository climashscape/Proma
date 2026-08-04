import { useEffect, useMemo, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { cn } from '@/lib/utils'
import { SettingsPanel } from './SettingsPanel'
import { settingsTabAtom, channelFormDirtyAtom, settingsCloseRequestedAtom, type SettingsTab } from '@/atoms/settings-tab'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WindowControls } from '@/components/WindowControls'
import { detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'

/** 独立设置窗口可直达的标签页白名单（tutorial 依赖主窗口 Tab 系统，不在此列）。 */
const OPENABLE_SETTINGS_TABS: SettingsTab[] = [
  'general', 'channels', 'vision-relay', 'prompts', 'proxy',
  'tools', 'bots', 'shortcuts', 'voice-input',
  'migration', 'storage', 'appearance', 'about',
]

/** 独立窗口模式：复用设置面板，不挂载聊天与 Agent 工作区。 */
export function SettingsWindowApp(): React.ReactElement {
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const channelFormDirty = useAtomValue(channelFormDirtyAtom)
  const setSettingsCloseRequested = useSetAtom(settingsCloseRequestedAtom)
  const channelFormDirtyRef = useRef(channelFormDirty)
  channelFormDirtyRef.current = channelFormDirty
  const isWindows = useMemo(() => detectIsWindows(), [])

  useEffect(() => {
    document.title = 'Proma · 设置'
    const tab = new URLSearchParams(window.location.search).get('tab')
    // 有合法 tab 参数时直达对应页（如「关于/更新」）；否则默认显示通用设置
    if (tab && (OPENABLE_SETTINGS_TABS as string[]).includes(tab)) {
      setSettingsTab(tab as SettingsTab)
    } else {
      setSettingsTab('general')
    }
  }, [setSettingsTab])

  // 主进程在窗口关闭前询问未保存内容：渠道表单 dirty 时交给 SettingsPanel 弹确认，
  // 确认后由 AlertDialog 的 executePendingAction 调 onClose（confirmSettingsClose）真正关闭。
  useEffect(() => {
    return window.electronAPI.onSettingsCloseRequested(() => {
      if (channelFormDirtyRef.current) {
        setSettingsCloseRequested(true)
        return
      }
      void window.electronAPI.confirmSettingsClose()
    })
  }, [setSettingsCloseRequested])

  return (
    <TooltipProvider delayDuration={200}>
      <div className="relative h-screen overflow-hidden shell-bg">
        {/* 顶部拖拽条：与主窗口 AppShell 一致的透明方案，Windows 上让出右上角按钮区 */}
        <div
          className={cn(
            'titlebar-drag-region fixed top-0 left-0 h-[40px] z-50',
            isWindows ? WINDOW_CONTROLS_INSET_RIGHT : 'right-0',
          )}
        />
        <WindowControls />
        <SettingsPanel standalone onClose={() => void window.electronAPI.confirmSettingsClose()} />
      </div>
    </TooltipProvider>
  )
}
