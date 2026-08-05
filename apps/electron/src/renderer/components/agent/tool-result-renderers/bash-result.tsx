/**
 * Bash 工具结果渲染器 — 终端风格
 *
 * 固定高度终端块（max-h-[320px] + 内部滚动），运行中与结束时高度一致：
 * - 运行中：实时显示 stdout/stderr chunk，自动滚动跟随、暂停/恢复、ANSI 颜色、stderr 高亮
 * - 结束：同一固定高度块展示完整输出（可内部滚动 + 复制），仅去掉“执行中”脉冲
 * 展开/折叠由外层 ContentBlock 控制：展开 = 完整输出块，折叠 = 无输出块
 *
 * ANSI SGR 解析：轻量实现，支持 16/256/truecolor 前景/背景、粗体/斜体/下划线等样式。
 * 注：Pi SDK 的 bash-executor（远程/SSH 路径）会剥离 ANSI；但 Proma 实际使用的
 * 本地 Bash 工具（createLocalBashOperations / WSL operations）不剥离 ANSI，
 * 因此 npm run build 等命令的彩色输出会被保留并在此解析。此解析器对未来
 * SDK 行为变化也保持防御性（无 dangerouslySetInnerHTML，无注入风险）。
 */

import * as React from 'react'
import { Check, Copy, Pause, Play, ListEnd } from 'lucide-react'
import { cn } from '@/lib/utils'
import { copyTextToClipboard } from '@/lib/clipboard'

interface BashResultRendererProps {
  result: string
  isError: boolean
  input: Record<string, unknown>
  /** 执行期间的实时流式输出 */
  streamingOutput?: string
  /** 是否处于流式输出中 */
  isStreamingOutput?: boolean
}

/** 简单检测 stderr 行（常见模式） */
function classifyLine(line: string): 'stderr' | 'normal' {
  const lower = line.toLowerCase()
  if (
    lower.startsWith('error:') ||
    lower.startsWith('error ') ||
    lower.startsWith('fatal:') ||
    lower.startsWith('warning:') ||
    lower.includes('traceback') ||
    lower.includes('exception') ||
    lower.startsWith('stderr:')
  ) {
    return 'stderr'
  }
  return 'normal'
}

// ============================================================================
// ANSI SGR 解析 — 将转义序列转换为 React span 样式
// ============================================================================

interface AnsiStyle {
  fg?: string
  bg?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
  strikethrough?: boolean
}

const ANSI_SGR_RE = /\x1b\[([0-9;]*)m/g

/** 16 色基础色板（标准色 + 亮色） */
const ANSI_16_COLORS: Record<number, string> = {
  30: '#333333', 31: '#c91b00', 32: '#00c200', 33: '#c7c400',
  34: '#0225c7', 35: '#c930c7', 36: '#00c5c7', 37: '#c7c7c7',
  90: '#676767', 91: '#ff6d67', 92: '#5ff967', 93: '#fefb67',
  94: '#6871ff', 95: '#ff76ff', 96: '#5ffdff', 97: '#ffffff',
}

/** 256 色（xterm）：16 + 216 立方体 + 24 灰阶 */
function ansi256Color(code: number): string {
  if (code < 16) return ANSI_16_COLORS[code] ?? '#ffffff'
  if (code < 232) {
    // 6×6×6 立方体
    const idx = code - 16
    const r = Math.floor(idx / 36)
    const g = Math.floor((idx % 36) / 6)
    const b = idx % 6
    const scale = (v: number): number => (v === 0 ? 0 : 55 + v * 40)
    return `rgb(${scale(r)},${scale(g)},${scale(b)})`
  }
  // 24 阶灰度
  const gray = 8 + (code - 232) * 10
  return `rgb(${gray},${gray},${gray})`
}

/** 解析一段 SGR 转义文本，返回带样式的分段数组（导出供单元测试） */
export function parseAnsiSgr(text: string): Array<{ text: string; style: AnsiStyle }> {
  const segments: Array<{ text: string; style: AnsiStyle }> = []
  let lastIndex = 0
  let style: AnsiStyle = {}

  const pushPlain = (end: number): void => {
    if (end > lastIndex) {
      const plain = text.slice(lastIndex, end)
      segments.push({ text: plain, style: { ...style } })
    }
  }

  ANSI_SGR_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ANSI_SGR_RE.exec(text)) !== null) {
    pushPlain(match.index)
    lastIndex = ANSI_SGR_RE.lastIndex

    const codes = match[1] === '' ? [0] : match[1]!.split(';').map((n) => Number.parseInt(n, 10))
    // 解析参数序列（支持 38;5;n / 38;2;r;g;b 等复合码）
    let i = 0
    while (i < codes.length) {
      const code = codes[i]!
      if (code === 0) {
        style = {}
      } else if (code === 1) {
        style.bold = true
      } else if (code === 2) {
        style.dim = true
      } else if (code === 3) {
        style.italic = true
      } else if (code === 4) {
        style.underline = true
      } else if (code === 9) {
        style.strikethrough = true
      } else if (code === 22) {
        style.bold = false
        style.dim = false
      } else if (code === 23) {
        style.italic = false
      } else if (code === 24) {
        style.underline = false
      } else if (code === 29) {
        style.strikethrough = false
      } else if (code >= 30 && code <= 37) {
        style.fg = ANSI_16_COLORS[code]!
      } else if (code >= 40 && code <= 47) {
        style.bg = ANSI_16_COLORS[code - 10]!
      } else if (code >= 90 && code <= 97) {
        style.fg = ANSI_16_COLORS[code]!
      } else if (code >= 100 && code <= 107) {
        style.bg = ANSI_16_COLORS[code - 10]!
      } else if (code === 38 || code === 48) {
        // 扩展前景/背景色：38;5;n | 38;2;r;g;b
        const target = code === 38 ? 'fg' : 'bg'
        const mode = codes[i + 1]
        if (mode === 5 && typeof codes[i + 2] === 'number') {
          const color = ansi256Color(codes[i + 2]!)
          if (target === 'fg') style.fg = color
          else style.bg = color
          i += 2
        } else if (mode === 2 && typeof codes[i + 2] === 'number' && typeof codes[i + 3] === 'number' && typeof codes[i + 4] === 'number') {
          const color = `rgb(${codes[i + 2]!},${codes[i + 3]!},${codes[i + 4]!})`
          if (target === 'fg') style.fg = color
          else style.bg = color
          i += 4
        }
      } else if (code === 39) {
        style.fg = undefined
      } else if (code === 49) {
        style.bg = undefined
      }
      i++
    }
  }
  pushPlain(text.length)
  return segments
}

/** 将带样式分段渲染为 React 节点 */
function renderAnsiSegments(segments: Array<{ text: string; style: AnsiStyle }>): React.ReactNode[] {
  return segments.map((segment, idx) => {
    const { text: segText, style } = segment
    const styleObj: React.CSSProperties = {}
    if (style.fg) styleObj.color = style.fg
    if (style.bg) styleObj.backgroundColor = style.bg
    if (style.bold) styleObj.fontWeight = 600
    if (style.dim) styleObj.opacity = 0.6
    if (style.italic) styleObj.fontStyle = 'italic'
    if (style.underline) styleObj.textDecoration = 'underline'
    if (style.strikethrough) styleObj.textDecoration = 'line-through'
    return (
      <span key={idx} style={styleObj}>
        {segText}
      </span>
    )
  })
}

// ============================================================================
// 流式终端组件
// ============================================================================

interface StreamingTerminalProps {
  output: string
  command?: string
  isError?: boolean
  isFinished: boolean
}

/** 流式终端：深色背景 + 自动滚动 + 暂停/恢复 + 实时行渲染 */
function StreamingTerminal({ output, command, isError, isFinished }: StreamingTerminalProps): React.ReactElement {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  /** 是否跟随底部滚动（用户上滚查看历史时暂停跟随） */
  const [followBottom, setFollowBottom] = React.useState(true)
  /** 用户手动暂停滚动 */
  const [paused, setPaused] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  // 新输出到达且未暂停跟随 → 滚动到底部
  React.useEffect(() => {
    const el = scrollRef.current
    if (el && followBottom && !paused) {
      el.scrollTop = el.scrollHeight
    }
  }, [output, followBottom, paused])

  const handleScroll = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // 距离底部 < 24px 视为跟随；否则暂停跟随（供用户回看）
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    setFollowBottom(nearBottom)
  }, [])

  const handleCopy = React.useCallback(async () => {
    try {
      await copyTextToClipboard(output)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('复制失败:', error)
    }
  }, [output])

  const togglePause = React.useCallback(() => {
    setPaused((prev) => {
      const next = !prev
      if (!next) setFollowBottom(true)
      return next
    })
  }, [])

  const scrollToBottom = React.useCallback(() => {
    setFollowBottom(true)
    setPaused(false)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // 渲染输出行（ANSI 解析 + stderr 启发式高亮）
  // 仅渲染最近 MAX_RENDER_LINES 行，避免长输出（如 build 日志）DOM 爆炸；
  // 完整输出仍可通过复制按钮获取。
  const MAX_RENDER_LINES = 500
  const renderLines = React.useMemo(() => {
    const lines = output.split('\n')
    const tail = lines.length > MAX_RENDER_LINES ? lines.slice(-MAX_RENDER_LINES) : lines
    return tail.map((line, i) => {
      const segments = parseAnsiSgr(line)
      const hasAnsi = segments.some((s) => s.style.fg || s.style.bg || s.style.bold || s.style.italic || s.style.underline || s.style.dim || s.style.strikethrough)
      const isStderr = isError || (!hasAnsi && classifyLine(line) === 'stderr')
      return (
        <div
          key={lines.length - tail.length + i}
          className={cn(
            'whitespace-pre-wrap break-all min-h-[1.25em]',
            isStderr && 'text-red-400',
          )}
        >
          {hasAnsi ? renderAnsiSegments(segments) : (line || '\u200B')}
        </div>
      )
    })
  }, [output, isError])

  const lineCount = React.useMemo(() => output.split('\n').length, [output])
  const showPauseControl = !isFinished && lineCount > 3
  const truncatedLines = lineCount - Math.min(lineCount, MAX_RENDER_LINES)

  return (
    <div className="relative">
      {/* 终端容器 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={cn(
          'rounded-md font-mono text-[12px] leading-relaxed overflow-y-auto',
          'bg-zinc-900 text-zinc-100 dark:bg-zinc-950',
          'p-3',
          'max-h-[320px]',
        )}
      >
        {/* 命令回显 */}
        {command && (
          <div className="text-zinc-500 mb-2 select-none sticky top-0 bg-zinc-900 dark:bg-zinc-950">
            <span className="text-green-400">$</span> {command}
          </div>
        )}
        {truncatedLines > 0 && (
          <div className="text-zinc-600 select-none mb-1">… 省略前 {truncatedLines} 行（复制可获取完整输出）</div>
        )}
        {isFinished && output.trim().length === 0 ? (
          <div className="text-zinc-500 select-none">(no output)</div>
        ) : (
          renderLines
        )}
        {isStreamingTailIndicator()}
      </div>

      {/* 工具条：暂停/恢复 + 回到底部 + 复制 */}
      <div className="absolute right-2 top-2 flex items-center gap-1">
        {showPauseControl && (
          <button
            type="button"
            onClick={togglePause}
            className="flex h-6 items-center gap-1 rounded-md bg-zinc-800/90 px-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
            title={paused ? '恢复自动滚动' : '暂停滚动'}
          >
            {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
            {paused ? '继续' : '暂停'}
          </button>
        )}
        {!followBottom && !paused && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="flex h-6 items-center gap-1 rounded-md bg-zinc-800/90 px-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
            title="回到最新输出"
          >
            <ListEnd className="size-3" />
            回到底部
          </button>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="flex h-6 items-center gap-1 rounded-md bg-zinc-800/90 px-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
          title="复制当前可见输出（长输出仅含尾部，结束后可复制完整内容）"
        >
          {copied ? <Check className="size-3 text-green-400" /> : <Copy className="size-3" />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
    </div>
  )

  /** 流式中的光标提示 */
  function isStreamingTailIndicator(): React.ReactNode {
    if (isFinished) return null
    return (
      <div className="flex items-center gap-1 mt-0.5 text-zinc-500 select-none">
        <span className="inline-block size-1.5 rounded-full bg-green-500 animate-pulse" />
        <span className="text-[11px]">执行中…</span>
      </div>
    )
  }
}

// ============================================================================
// 主渲染器
// ============================================================================

export function BashResultRenderer({ result, isError, input, streamingOutput, isStreamingOutput }: BashResultRendererProps): React.ReactElement {
  const command = typeof input.command === 'string' ? input.command : undefined

  // 固定高度终端块：无论运行中还是结束，块高度一致（max-h-[320px] + 内部滚动）。
  // 展开 = 完整输出块（由外层 ContentBlock 控制），折叠 = 无输出块。
  const finalText = result || streamingOutput || ''

  // 空输出兜底：同样固定高度，避免无输出时块消失造成跳动
  if (isStreamingOutput && !finalText) {
    return <StreamingTerminal output="" command={command} isError={isError} isFinished={false} />
  }

  return (
    <StreamingTerminal
      output={finalText}
      command={command}
      isError={isError}
      isFinished={!isStreamingOutput}
    />
  )
}
