/**
 * 全局快捷键服务（主进程）
 *
 * 使用 Electron globalShortcut API 注册系统级快捷键。
 * - 全局快捷键：应用不在前台时也能触发（始终注册）
 * - 应用级快捷键：仅在窗口聚焦时注册，失焦时注销（微信模式）
 *
 * 与渲染进程的 shortcut-registry 完全独立：
 * - 渲染进程：keydown listener，仅应用内生效（fallback）
 * - 主进程：globalShortcut.register，系统级生效
 */

import { app, globalShortcut } from 'electron'
import { getSettings } from './settings-service'

/** 快捷键 ID → 回调映射 */
const globalCallbacks = new Map<string, () => void>()

/** 应用级快捷键 ID → 回调映射 */
const appCallbacks = new Map<string, () => void>()

/** 当前注册的 accelerator → 快捷键 ID 映射（用于注销） */
const registeredAccelerators = new Map<string, string>()

/** 当前注册的应用级 accelerator → 快捷键 ID 映射 */
const registeredAppAccelerators = new Map<string, string>()

/** 应用级快捷键是否当前已注册（受 focus/blur 控制） */
let appShortcutsRegistered = false

/** 默认全局快捷键配置 */
const GLOBAL_SHORTCUT_DEFAULTS: Record<string, { mac: string; win: string }> = {
  'quick-task': { mac: 'Alt+Space', win: 'Alt+Space' },
  'show-main-window': { mac: 'CommandOrControl+Shift+P', win: 'CommandOrControl+Shift+P' },
  'voice-dictation': { mac: 'Ctrl+`', win: 'Ctrl+`' },
}

const isMac = process.platform === 'darwin'
const VOICE_DICTATION_SHORTCUT_ID = 'voice-dictation'

function shouldRegisterGlobalShortcut(id: string): boolean {
  if (id !== VOICE_DICTATION_SHORTCUT_ID) return true
  return getSettings().voiceDictation?.enabled === true
}

/**
 * 获取某全局快捷键当前生效的 Electron accelerator 字符串
 *
 * 返回值：
 * - 非空字符串：当前生效的 accelerator（用户自定义或默认值）
 * - `null`：用户已主动禁用此快捷键，跳过 globalShortcut.register
 *
 * 将 Cmd 统一转为 Electron 的 CommandOrControl；Ctrl 保持为物理 Control 键。
 */
function getGlobalAccelerator(id: string): string | null {
  const settings = getSettings()
  const override = settings.shortcutOverrides?.[id]

  let accelerator: string
  if (override) {
    const customAccel = isMac ? override.mac : override.win
    if (customAccel === null) return null
    if (customAccel) {
      accelerator = customAccel
    } else {
      const def = GLOBAL_SHORTCUT_DEFAULTS[id]
      accelerator = def ? (isMac ? def.mac : def.win) : ''
    }
  } else {
    const def = GLOBAL_SHORTCUT_DEFAULTS[id]
    accelerator = def ? (isMac ? def.mac : def.win) : ''
  }

  // 转换为 Electron 标准格式
  return accelerator
    .split('+')
    .map((part) => part.trim().toLowerCase() === 'cmd' ? 'CommandOrControl' : part)
    .join('+')
}

/**
 * 注册单个全局快捷键
 *
 * @returns 是否注册成功（可能被系统占用）
 */
function registerOne(id: string): boolean {
  const callback = globalCallbacks.get(id)
  if (!callback) return false

  if (!shouldRegisterGlobalShortcut(id)) {
    console.log(`[全局快捷键] 跳过注册: ${id} 未启用`)
    return false
  }

  const accelerator = getGlobalAccelerator(id)
  if (accelerator === null) {
    console.log(`[全局快捷键] 跳过注册: ${id} 已被用户禁用`)
    return false
  }
  if (!accelerator) return false

  try {
    const success = globalShortcut.register(accelerator, callback)
    if (success) {
      registeredAccelerators.set(accelerator, id)
      console.log(`[全局快捷键] 注册成功: ${id} → ${accelerator}`)
    } else {
      console.warn(`[全局快捷键] 注册失败（可能被占用）: ${id} → ${accelerator}`)
    }
    return success
  } catch (err) {
    console.error(`[全局快捷键] 注册异常: ${id} → ${accelerator}`, err)
    return false
  }
}

/**
 * 检查某个 accelerator 是否可被注册为全局快捷键
 *
 * 原理：尝试注册一个 dummy callback，成功则立即注销并返回 true，
 * 失败则返回 false。不会影响当前已注册的全局快捷键。
 *
 * 注意：传入的 accelerator 需要先通过 getGlobalAccelerator 转换为 Electron 标准格式
 *（如将 Cmd 转为 CommandOrControl），否则 macOS 上检测会失败。
 */
export function checkGlobalAcceleratorAvailability(accelerator: string): boolean {
  if (!accelerator) return false

  // 转换为 Electron 标准格式（与 getGlobalAccelerator 保持一致）
  const normalizedAccel = accelerator
    .split('+')
    .map((part) => part.trim().toLowerCase() === 'cmd' ? 'CommandOrControl' : part)
    .join('+')

  // 如果该 accelerator 已经被 Proma 自己注册了（全局或应用级），说明可用
  if (registeredAccelerators.has(normalizedAccel)) return true
  if (registeredAppAccelerators.has(normalizedAccel)) return true

  try {
    const success = globalShortcut.register(normalizedAccel, () => {})
    if (success) {
      globalShortcut.unregister(normalizedAccel)
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 注册全局快捷键回调
 *
 * 在 app.whenReady() 后调用。设置回调函数并尝试注册。
 */
export function registerGlobalShortcut(id: string, callback: () => void): boolean {
  globalCallbacks.set(id, callback)
  return registerOne(id)
}

/**
 * 重新注册所有全局快捷键
 *
 * 用户在设置中修改全局快捷键后调用。
 * 先注销所有已注册的，再重新注册。
 */
export function reregisterAllGlobalShortcuts(): Record<string, boolean> {
  // 注销所有已注册的
  for (const accelerator of registeredAccelerators.keys()) {
    try {
      globalShortcut.unregister(accelerator)
    } catch {
      // 忽略注销错误
    }
  }
  registeredAccelerators.clear()

  // 重新注册所有有回调的快捷键
  const results: Record<string, boolean> = {}
  for (const id of globalCallbacks.keys()) {
    results[id] = registerOne(id)
  }
  return results
}

/**
 * 注销所有全局快捷键
 *
 * 在 app.will-quit / before-quit 时调用。
 */
export function unregisterAllGlobalShortcuts(): void {
  if (app.isReady()) {
    globalShortcut.unregisterAll()
  }
  registeredAccelerators.clear()
  registeredAppAccelerators.clear()
  globalCallbacks.clear()
  appCallbacks.clear()
  appShortcutsRegistered = false
  console.log('[全局快捷键] 已注销所有')
}

// ===== 应用级快捷键（focus/blur 生命周期） =====

/** 应用级快捷键配置：ID → { accelerator, callback } */
interface AppShortcutEntry {
  accelerator: string
  callback: () => void
}

/** 应用级快捷键配置表（由渲染进程通过 IPC 设置） */
const appShortcutEntries = new Map<string, AppShortcutEntry>()

/**
 * 设置应用级快捷键
 *
 * 渲染进程通过 IPC 调用，将所有非全局快捷键的 accelerator 和回调注册到主进程。
 * 回调通过 IPC 通知渲染进程执行对应快捷键动作。
 */
export function setAppShortcuts(
  shortcuts: Array<{ id: string; accelerator: string }>,
  sendCallback: (id: string) => void,
): void {
  appShortcutEntries.clear()
  for (const { id, accelerator } of shortcuts) {
    appShortcutEntries.set(id, { accelerator, callback: () => sendCallback(id) })
  }

  // 如果窗口当前聚焦，立即注册
  if (appShortcutsRegistered) {
    registerAppShortcutsNow()
  }
}

/**
 * 注册所有应用级快捷键
 *
 * 在主窗口获得焦点时调用。
 */
function registerAppShortcutsNow(): void {
  // 先注销旧的应用级快捷键
  unregisterAppShortcutsNow()

  for (const [id, entry] of appShortcutEntries) {
    // 跳过被用户禁用的快捷键
    const override = getSettings().shortcutOverrides?.[id]
    if (override) {
      const customAccel = isMac ? override.mac : override.win
      if (customAccel === null) continue
    }

    const accelerator = normalizeAccelerator(entry.accelerator)
    if (!accelerator) continue

    try {
      const success = globalShortcut.register(accelerator, entry.callback)
      if (success) {
        registeredAppAccelerators.set(accelerator, id)
      } else {
        console.warn(`[应用快捷键] 注册失败（可能被占用）: ${id} → ${accelerator}`)
      }
    } catch (err) {
      console.error(`[应用快捷键] 注册异常: ${id} → ${accelerator}`, err)
    }
  }
  appShortcutsRegistered = true
}

/**
 * 注销所有应用级快捷键
 *
 * 在主窗口失去焦点时调用。
 */
function unregisterAppShortcutsNow(): void {
  for (const accelerator of registeredAppAccelerators.keys()) {
    try {
      globalShortcut.unregister(accelerator)
    } catch {
      // 忽略注销错误
    }
  }
  registeredAppAccelerators.clear()
}

/**
 * 主窗口获得焦点 — 注册应用级快捷键
 */
export function onWindowFocus(): void {
  registerAppShortcutsNow()
}

/**
 * 主窗口失去焦点 — 注销应用级快捷键
 */
export function onWindowBlur(): void {
  unregisterAppShortcutsNow()
  appShortcutsRegistered = false
}

/**
 * 重新注册应用级快捷键
 *
 * 设置变更后调用。返回各快捷键注册结果。
 */
export function reregisterAppShortcuts(): Record<string, boolean> {
  const results: Record<string, boolean> = {}

  // 如果当前已注册，先注销再重新注册
  if (appShortcutsRegistered) {
    unregisterAppShortcutsNow()
    registerAppShortcutsNow()
  }

  // 收集结果
  for (const [id] of appShortcutEntries) {
    const entry = appShortcutEntries.get(id)
    if (!entry) {
      results[id] = false
      continue
    }
    const accelerator = normalizeAccelerator(entry.accelerator)
    results[id] = registeredAppAccelerators.has(accelerator)
  }

  return results
}

/**
 * 标准化 accelerator 字符串为 Electron 格式
 */
function normalizeAccelerator(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => part.trim().toLowerCase() === 'cmd' ? 'CommandOrControl' : part)
    .join('+')
}
