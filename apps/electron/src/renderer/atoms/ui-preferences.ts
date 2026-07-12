/**
 * UI 偏好设置状态管理
 *
 * 管理用户界面相关的显示偏好，如悬浮置顶条、输入框 Markdown 渲染等。
 */

import { atom } from 'jotai'

// ===== Jotai Atoms =====

/** 是否显示用户消息悬浮置顶条 */
export const stickyUserMessageEnabledAtom = atom<boolean>(true)

/** 粘贴长文本时是否自动转为附件 */
export const longTextPasteAsAttachmentEnabledAtom = atom<boolean>(false)

/** 输入框是否渲染 Markdown 富文本格式（默认关闭，纯文本模式；开启后渲染富文本，仍保留 Mention 引用） */
export const richTextRenderingEnabledAtom = atom<boolean>(false)
/** 渐进式更新会话标题（话题偏移时自动重新生成，仅普通主会话生效） */
export const progressiveTitleUpdateEnabledAtom = atom<boolean>(true)

/** 渐进式标题更新/手动重生成所用模型渠道 ID（空 = 跟随当前会话渠道） */
export const titleModelChannelIdAtom = atom<string>('')

/** 渐进式标题更新/手动重生成所用模型 ID（空 = 跟随当前会话模型） */
export const titleModelIdAtom = atom<string>('')

// ===== 初始化 =====

/**
 * 从主进程加载 UI 偏好设置
 */
export async function initializeUiPreferences(
  setStickyUserMessageEnabled: (enabled: boolean) => void,
  setLongTextPasteAsAttachmentEnabled?: (enabled: boolean) => void,
  setRichTextRenderingEnabled?: (enabled: boolean) => void,
  setProgressiveTitleUpdateEnabled?: (enabled: boolean) => void,
  setTitleModelChannelId?: (channelId: string) => void,
  setTitleModelId?: (modelId: string) => void,
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    setStickyUserMessageEnabled(settings.stickyUserMessageEnabled ?? true)
    setLongTextPasteAsAttachmentEnabled?.(settings.longTextPasteAsAttachmentEnabled ?? false)
    setRichTextRenderingEnabled?.(settings.richTextRenderingEnabled ?? false)
    setProgressiveTitleUpdateEnabled?.(settings.progressiveTitleUpdateEnabled ?? true)
    setTitleModelChannelId?.(settings.titleModelChannelId ?? '')
    setTitleModelId?.(settings.titleModelId ?? '')
  } catch (error) {
    console.error('[UI偏好] 初始化失败:', error)
  }
}

// ===== 持久化更新 =====

/**
 * 更新悬浮置顶条开关并持久化
 */
export async function updateStickyUserMessageEnabled(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ stickyUserMessageEnabled: enabled })
  } catch (error) {
    console.error('[UI偏好] 更新悬浮置顶条设置失败:', error)
  }
}

/**
 * 更新长文本粘贴转附件开关并持久化
 */
export async function updateLongTextPasteAsAttachmentEnabled(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ longTextPasteAsAttachmentEnabled: enabled })
  } catch (error) {
    console.error('[UI偏好] 更新长文本粘贴附件设置失败:', error)
  }
}

/**
 * 更新输入框 Markdown 渲染开关并持久化
 */
export async function updateRichTextRenderingEnabled(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ richTextRenderingEnabled: enabled })
  } catch (error) {
    console.error('[UI偏好] 更新输入框 Markdown 渲染设置失败:', error)
  }
}

/**
 * 更新渐进式标题更新开关并持久化
 */
export async function updateProgressiveTitleUpdateEnabled(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ progressiveTitleUpdateEnabled: enabled })
  } catch (error) {
    console.error('[UI偏好] 更新渐进式标题更新设置失败:', error)
  }
}

/**
 * 更新渐进式标题更新所用模型并持久化
 *
 * @param channelId 渠道 ID，空字符串表示清除（跟随会话渠道）
 * @param modelId 模型 ID，空字符串表示清除（跟随会话模型）
 */
export async function updateTitleModel(channelId: string, modelId: string): Promise<void> {
  try {
    await window.electronAPI.updateSettings({
      titleModelChannelId: channelId,
      titleModelId: modelId,
    })
  } catch (error) {
    console.error('[UI偏好] 更新标题模型设置失败:', error)
  }
}
