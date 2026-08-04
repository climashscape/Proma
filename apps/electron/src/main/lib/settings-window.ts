import { app, BrowserWindow, screen, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MainWindowState } from '../../types'
import { getPersistableMainWindowState } from './main-window-lifecycle'
import { getSettings, updateSettings } from './settings-service'
import { SETTINGS_IPC_CHANNELS } from '../../types'
import type { SettingsTab } from '../../renderer/atoms/settings-tab'

const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 860
const MIN_WIDTH = 900
const MIN_HEIGHT = 600
const SETTINGS_WINDOW_TITLE = 'Proma · 设置'

let settingsWindow: BrowserWindow | null = null
/** 渲染进程确认可关闭后才置为 true；用于拦截未保存的渠道表单。 */
let closeConfirmed = false

function getIconPath(): string | undefined {
  const resourcesDir = join(__dirname, 'resources')
  const filename = process.platform === 'darwin'
    ? 'icon.icns'
    : process.platform === 'win32'
      ? 'icon.ico'
      : 'icon.png'
  const iconPath = join(resourcesDir, filename)
  return existsSync(iconPath) ? iconPath : undefined
}

function getInitialBounds(savedState?: MainWindowState): Electron.Rectangle {
  if (savedState) {
    return { x: savedState.x, y: savedState.y, width: savedState.width, height: savedState.height }
  }

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width, height } = display.workArea
  const windowWidth = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, width - 80))
  const windowHeight = Math.min(DEFAULT_HEIGHT, Math.max(MIN_HEIGHT, height - 80))
  return {
    x: x + Math.round((width - windowWidth) / 2),
    y: y + Math.round((height - windowHeight) / 2),
    width: windowWidth,
    height: windowHeight,
  }
}

function ensureWindowOnScreen(win: BrowserWindow): void {
  const bounds = win.getBounds()
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return centerX >= area.x && centerX <= area.x + area.width && centerY >= area.y && centerY <= area.y + area.height
  })
  if (visible) return

  const area = screen.getPrimaryDisplay().workArea
  win.setPosition(
    area.x + Math.round((area.width - bounds.width) / 2),
    area.y + Math.round((area.height - bounds.height) / 2),
  )
}

function isDevServerNavigation(url: string): boolean {
  try {
    return new URL(url).origin === 'http://127.0.0.1:5173'
  } catch {
    return false
  }
}

function persistSettingsWindowState(win: BrowserWindow): void {
  const state = getPersistableMainWindowState(win)
  if (!state) return
  try {
    updateSettings({ settingsWindowState: state })
  } catch (error) {
    console.error('[设置窗口] 保存窗口状态失败:', error)
  }
}

function createSettingsWindow(tab?: SettingsTab): BrowserWindow {
  const savedState = getSettings().settingsWindowState
  const isMac = process.platform === 'darwin'
  const isWindows = process.platform === 'win32'
  const titleBarOptions = isMac
    ? {
        titleBarStyle: 'hiddenInset' as const,
        trafficLightPosition: { x: 18, y: 18 },
        vibrancy: 'under-window' as const,
        visualEffectState: 'followWindow' as const,
      }
    : isWindows
      ? { titleBarStyle: 'hidden' as const }
      : {}
  const win = new BrowserWindow({
    ...getInitialBounds(savedState),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: SETTINGS_WINDOW_TITLE,
    icon: getIconPath(),
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    ...titleBarOptions,
  })
  settingsWindow = win
  closeConfirmed = false
  ensureWindowOnScreen(win)

  const query = new URLSearchParams({ window: 'settings' })
  if (tab) query.set('tab', tab)
  const isDev = !app.isPackaged
  if (isDev) {
    void win.loadURL(`http://127.0.0.1:5173?${query.toString()}`)
  } else {
    void win.loadFile(join(__dirname, 'renderer', 'index.html'), { query: Object.fromEntries(query) })
  }

  win.once('ready-to-show', () => {
    if (savedState?.isMaximized) win.maximize()
    win.show()
    win.focus()
  })

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const flushState = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    persistSettingsWindowState(win)
  }
  const scheduleStateSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      persistSettingsWindowState(win)
    }, 500)
  }
  win.on('resize', scheduleStateSave)
  win.on('move', scheduleStateSave)
  win.on('maximize', scheduleStateSave)
  win.on('unmaximize', scheduleStateSave)
  win.on('close', flushState)

  // 拦截关闭：未确认前先请求渲染进程检查未保存内容（渠道表单 dirty），
  // 渲染进程确认后通过 confirmSettingsWindowClose 再次关闭。
  win.on('close', (event) => {
    if (closeConfirmed || win.webContents.isDestroyed()) return
    event.preventDefault()
    win.webContents.send(SETTINGS_IPC_CHANNELS.REQUEST_CLOSE)
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (isDev && isDevServerNavigation(url)) return
    event.preventDefault()
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null
  })

  return win
}

/** 打开单例设置窗口；已存在时恢复、确保可见并聚焦。tab 仅在新建窗口时生效。 */
export function showSettingsWindow(tab?: SettingsTab): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    createSettingsWindow(tab)
    return
  }
  ensureWindowOnScreen(settingsWindow)
  if (settingsWindow.isMinimized()) settingsWindow.restore()
  settingsWindow.show()
  settingsWindow.focus()
}

/** 渲染进程确认可关闭后调用：放行关闭拦截并真正关闭窗口。 */
export function confirmSettingsWindowClose(win: BrowserWindow): void {
  if (settingsWindow !== win) return
  closeConfirmed = true
  win.close()
}

/** 应用退出时销毁窗口，确保状态保存定时器与渲染进程一同释放。 */
export function destroySettingsWindow(): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) return
  persistSettingsWindowState(settingsWindow)
  settingsWindow.destroy()
  settingsWindow = null
}
