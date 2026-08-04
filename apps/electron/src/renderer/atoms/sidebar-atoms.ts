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

/** 被折叠的项目（工作区）ID 列表，持久化到 localStorage；保存用户的展开/折叠习惯，重启后自动恢复 */
const collapsedWorkspaceIdsStorageAtom = atomWithStorage<string[]>(
  'proma-collapsed-workspace-ids',
  [],
  undefined,
  { getOnInit: true },
)

/** 以 Set 形式暴露折叠项目 ID；写入时自动序列化为数组持久化（本地状态默认展开 = 空集合） */
export const collapsedWorkspaceIdsAtom = atom(
  (get) => new Set(get(collapsedWorkspaceIdsStorageAtom)),
  (get, set, update: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const next =
      typeof update === 'function'
        ? update(new Set(get(collapsedWorkspaceIdsStorageAtom)))
        : update
    const nextArray = [...next]
    // 内容无变化时跳过写入，避免 no-op 更新触发重渲染与多余 localStorage 写
    const current = get(collapsedWorkspaceIdsStorageAtom)
    if (current.length === nextArray.length && current.every((id, i) => id === nextArray[i])) {
      return
    }
    set(collapsedWorkspaceIdsStorageAtom, nextArray)
  },
)
