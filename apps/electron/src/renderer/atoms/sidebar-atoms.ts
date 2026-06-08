/**
 * 侧边栏状态 Atoms
 *
 * 管理侧边栏视图模式（活跃 / 已归档）、项目列表展示形态、项目列表高度。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

/** 侧边栏视图模式 */
export type SidebarViewMode = 'active' | 'archived'

/** 侧边栏视图模式（active = 显示活跃对话，archived = 显示已归档对话） */
export const sidebarViewModeAtom = atom<SidebarViewMode>('active')

/** 项目列表展示形态：下拉选择器 / 垂直列表 */
export type WorkspaceListMode = 'dropdown' | 'list'

/** 项目列表展示形态（持久化到 localStorage） */
export const workspaceListModeAtom = atomWithStorage<WorkspaceListMode>(
  'proma-workspace-list-mode',
  'dropdown',
)

/** 项目垂直列表高度（仅 list 形态使用，持久化到 localStorage） */
export const projectListHeightAtom = atomWithStorage<number>(
  'proma-workspace-list-height',
  120,
)
