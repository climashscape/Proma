/**
 * 相对时间格式化（左右侧栏共用）
 *
 * 按 updatedAt 与当前时间的差值输出中文相对时间；`now` 由调用方注入，
 * 以便列表复用同一时刻（配合定时刷新），避免每行各自取 Date.now() 造成标签不同步。
 */
export function formatRelativeUpdatedAt(updatedAt: number, now: number): string {
  const diff = Math.max(0, now - updatedAt)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const month = 30 * day
  const year = 365 * day

  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))} 分钟`
  if (diff < day) return `${Math.floor(diff / hour)} 小时`
  if (diff < month) return `${Math.floor(diff / day)} 天`
  if (diff < year) return `${Math.floor(diff / month)} 月`
  return `${Math.floor(diff / year)} 年`
}
