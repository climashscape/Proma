/**
 * 侧边栏状态 Atoms
 *
 * 管理侧边栏视图模式（活跃 / 已归档）。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

/** 侧边栏视图模式 */
export type SidebarViewMode = 'active' | 'archived'

/** 侧边栏视图模式（active = 显示活跃对话，archived = 显示已归档对话） */
export const sidebarViewModeAtom = atom<SidebarViewMode>('active')

/** 项目列表高度（px），用户可拖拽调整，持久化到 localStorage */
export const projectListHeightAtom = atomWithStorage<number>(
  'proma-workspace-list-height',
  120,
)

/** 左侧边栏宽度（px），用户可拖拽调整，持久化到 localStorage */
export const leftSidebarWidthAtom = atomWithStorage<number>(
  'proma-left-sidebar-width',
  300,
)

/** 自动任务区折叠状态（持久化到 localStorage） */
export const automationCollapsedAtom = atomWithStorage<boolean>(
  'proma-automation-collapsed',
  false,
)

/** 各项目折叠状态（持久化到 localStorage），key = workspaceId */
export const projectCollapsedMapAtom = atomWithStorage<Record<string, boolean>>(
  'proma-project-collapsed-map',
  {},
)

/** 用户展开的委派母会话 ID 列表（持久化到 localStorage） */
export const expandedDelegationParentIdsAtom = atomWithStorage<string[]>(
  'proma-expanded-delegation-parent-ids',
  [],
)

/** 用户手动收起的委派母会话 ID 列表（持久化到 localStorage） */
export const collapsedDelegationParentIdsAtom = atomWithStorage<string[]>(
  'proma-collapsed-delegation-parent-ids',
  [],
)
