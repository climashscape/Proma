/**
 * Settings Tab Atom - 设置标签页状态
 *
 * 管理设置面板中当前激活的标签页：
 * - general: 通用设置
 * - channels: 渠道配置
 * - proxy: 代理配置
 * - tools: Chat 工具配置
 * - appearance: 外观设置
 * - about: 关于
 */

import { atom } from 'jotai'
import type { SettingsTab } from '../../types'

/** 设置标签页类型（下沉到 types/settings.ts 共享，供主进程/preload/渲染进程复用） */
export type { SettingsTab }
export type ToolSettingsFocus = 'memory' | 'web-search' | 'nano-banana' | 'custom-tools'

/** 当前设置标签页（不持久化，每次打开设置默认显示渠道） */
export const settingsTabAtom = atom<SettingsTab>('channels')

/** Chat 工具设置页的目标配置区，用于从内置 MCP 详情直达对应配置 */
export const toolSettingsFocusAtom = atom<ToolSettingsFocus | null>(null)

/** 渠道创建表单是否有未保存内容（用于拦截导航离开） */
export const channelFormDirtyAtom = atom(false)

/** 外部请求关闭设置窗口（如 Cmd+W），SettingsPanel 监听后弹出确认对话框 */
export const settingsCloseRequestedAtom = atom(false)
