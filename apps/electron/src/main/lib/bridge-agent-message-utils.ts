/**
 * Pi runtime 的 message_update 会用 _partial 标记预览帧。
 * 这些帧通常携带"当前累计全文"，只适合 UI upsert，不应进入 IM Bridge 的最终回复 buffer。
 *
 * 注意：_partial 是 Pi SDK 内部实现字段（非公开契约），如 Pi SDK 版本更新后改变字段名，
 * 此函数会静默返回 false，可能导致 partial 消息被误判为最终消息。
 * 届时需同步更新此处判断。
 *
 * 【迁移说明】2026-07-15：isPartialSDKMessage 已移至 pi-message-adapter.ts，
 * 本文件仅保留导出以兼容旧导入，后续可移除。
 */

export { isPartialSDKMessage } from './adapters/pi-message-adapter'

/**
 * 从 Assistant 消息中提取最终文本内容。
 * 如果是预览帧（_partial === true）则返回空字符串。
 *
 * 【迁移说明】2026-07-15：extractFinalAssistantText 已移至 pi-message-adapter.ts，
 * 本文件仅保留导出以兼容旧导入，后续可移除。
 */
export { extractFinalAssistantText } from './adapters/pi-message-adapter'
