import { useEffect, useMemo } from 'react'
import { useStore, useSetAtom } from 'jotai'
import { cn } from '@/lib/utils'
import { SettingsPanel } from './SettingsPanel'
import { settingsTabAtom, channelFormDirtyAtom, settingsCloseRequestedAtom, type SettingsTab } from '@/atoms/settings-tab'
import { OPENABLE_SETTINGS_TABS } from '../../../types'
import { userProfileAtom } from '@/atoms/user-profile'
import { feishuBotStatesAtom } from '@/atoms/feishu-atoms'
import { dingtalkBotStatesAtom } from '@/atoms/dingtalk-atoms'
import { wechatBridgeStateAtom } from '@/atoms/wechat-atoms'
import { sendWithCmdEnterAtom, shortcutOverridesAtom } from '@/atoms/shortcut-atoms'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WindowControls } from '@/components/WindowControls'
import { detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'

/** 独立窗口模式：复用设置面板，不挂载聊天与 Agent 工作区。 */
export function SettingsWindowApp(): React.ReactElement {
  const store = useStore()
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const setUserProfile = useSetAtom(userProfileAtom)
  const setFeishuBots = useSetAtom(feishuBotStatesAtom)
  const setDingTalkBots = useSetAtom(dingtalkBotStatesAtom)
  const setWechatState = useSetAtom(wechatBridgeStateAtom)
  const setSendWithCmdEnter = useSetAtom(sendWithCmdEnterAtom)
  const setShortcutOverrides = useSetAtom(shortcutOverridesAtom)
  const setSettingsCloseRequested = useSetAtom(settingsCloseRequestedAtom)
  const isWindows = useMemo(() => detectIsWindows(), [])

  useEffect(() => {
    document.title = 'Proma · 设置'
    const tab = new URLSearchParams(window.location.search).get('tab')
    // 有合法 tab 参数时直达对应页（如「关于/更新」）；否则默认显示通用设置
    if (tab && (OPENABLE_SETTINGS_TABS as readonly string[]).includes(tab)) {
      setSettingsTab(tab as SettingsTab)
    } else {
      setSettingsTab('general')
    }
    // 加载已保存的用户档案（主窗口由 LeftSidebar 加载；独立窗口需要自行加载）
    window.electronAPI.getUserProfile().then(setUserProfile).catch(console.error)
    // 加载远程连接（BotHub）状态：只读取展示，不订阅/上报（避免主窗口初始化器的副作用）
    window.electronAPI.getFeishuMultiStatus?.()
      .then((r) => setFeishuBots(r.bots))
      .catch(() => {})
    window.electronAPI.getDingTalkMultiStatus?.()
      .then((r) => setDingTalkBots(r.bots))
      .catch(() => {})
    window.electronAPI.getWeChatStatus?.()
      .then(setWechatState)
      .catch(() => {})
    // 快捷键设置（主窗口由 GlobalShortcuts 加载；独立窗口需要自行加载）
    window.electronAPI.getSettings().then((settings) => {
      if (settings.sendWithCmdEnter !== undefined) setSendWithCmdEnter(settings.sendWithCmdEnter)
      if (settings.shortcutOverrides) setShortcutOverrides(settings.shortcutOverrides)
    }).catch(console.error)
    // 主窗口修改档案时同步更新（反向同步）
    const unsubProfile = window.electronAPI.onUserProfileChanged(setUserProfile)
    // 窗口已存在时主进程转发的标签页深链
    const unsubTab = window.electronAPI.onSettingsTabRequested((nextTab) => {
      if ((OPENABLE_SETTINGS_TABS as readonly string[]).includes(nextTab)) {
        setSettingsTab(nextTab)
      }
    })
    return () => {
      unsubProfile()
      unsubTab()
    }
  }, [setSettingsTab, setUserProfile, setFeishuBots, setDingTalkBots, setWechatState, setSendWithCmdEnter, setShortcutOverrides])

  // 主进程在窗口关闭前询问未保存内容：渠道表单 dirty 时交给 SettingsPanel 弹确认，
  // 确认后由 AlertDialog 的 executePendingAction 调 onClose（confirmSettingsClose）真正关闭。
  // 读取最新 dirty 状态使用 store.get，避免渲染期 ref 的快照竞态。
  useEffect(() => {
    return window.electronAPI.onSettingsCloseRequested(() => {
      if (store.get(channelFormDirtyAtom)) {
        setSettingsCloseRequested(true)
        return
      }
      void window.electronAPI.confirmSettingsClose()
    })
  }, [setSettingsCloseRequested, store])

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
        <SettingsPanel onClose={() => void window.electronAPI.confirmSettingsClose()} />
      </div>
    </TooltipProvider>
  )
}
