/**
 * ParallelDownloadExecutor — 并行分块下载器
 *
 * 覆写 ElectronHttpExecutor.download：对支持 Range 的 URL 做 N 段并行下载，
 * 聚合进度并校验 sha512（与 electron-updater 单连接下载结果等价）。
 *
 * 设计约束：
 * - 复用 Electron 的 net.request（走系统代理、Chromium 网络栈）；重定向用
 *   redirect: 'follow'（Electron 低层 API 保留自定义 Range 头）
 * - 多段写入同一文件句柄，用 pwrite 语义（fileHandle.write(position)）并行安全；
 *   每段内部串行写队列，且 position 在写入执行时计算（避免高速网络下陈旧偏移覆盖）
 * - 段请求只接受 206（防 Range 丢失导致全量写坏文件）；非 206 自动回退单连接
 * - 下载完成校验整个文件的 sha512（latest.yml 提供，支持 base64/hex），校验不通过即失败
 * - 不支持 Range / 文件过小 / 并行数为 1 → 回退父类单连接下载
 * - 取消（cancellationToken）时 abort 全部段、关闭句柄、清理临时文件，
 *   并让 createPromise 以 CancellationError 拒绝（与 electron-updater 取消语义一致）
 * - 进度按时间节流，避免 IPC 洪泛；正文阶段每段有 idle 超时，防段停滞挂起
 *
 * 差分下载（differential download）不受影响：走 downloadToBuffer，不经本 download()。
 */

import { createHash } from 'node:crypto'
import { promises as fs, createReadStream } from 'node:fs'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'
// 注意：electron-updater 自带一份 builder-util-runtime（版本与根 node_modules 不同），
// 必须从同一副本导入，否则 DownloadOptions/CancellationToken 类型声明不兼容。
import type { DownloadOptions } from 'electron-updater/node_modules/builder-util-runtime/out/httpExecutor'
import { configureRequestUrl, configureRequestOptions } from 'electron-updater/node_modules/builder-util-runtime/out/httpExecutor'
import { newError } from 'electron-updater/node_modules/builder-util-runtime/out/error'
import type { ProgressInfo } from 'electron-updater/node_modules/builder-util-runtime/out/ProgressCallbackTransform'
import type { ClientRequest, IncomingMessage, AuthInfo } from 'electron'

/** 并行段数 */
const DEFAULT_PARALLEL_COUNT = 8

/** 小于该大小的文件不做并行（单连接开销更小） */
const MIN_PARALLEL_SIZE = 5 * 1024 * 1024

/** 探测/请求/正文空闲超时（毫秒） */
const REQUEST_TIMEOUT = 60_000

/** 进度推送最小间隔（毫秒），防 IPC 洪泛 */
const PROGRESS_THROTTLE_MS = 500

interface ProbeResult {
  /** 总字节数 */
  size: number
  /** 是否支持 Range */
  acceptRanges: boolean
}

interface ChunkTask {
  start: number
  end: number
}

export class ParallelDownloadExecutor extends ElectronHttpExecutor {
  private readonly parallelCount: number

  constructor(
    proxyLoginCallback?: (authInfo: AuthInfo, callback: (username: string, password: string) => void) => void,
    parallelCount: number = DEFAULT_PARALLEL_COUNT,
  ) {
    super(proxyLoginCallback)
    this.parallelCount = parallelCount
  }

  override async download(url: URL, destination: string, options: DownloadOptions): Promise<string> {
    if (this.parallelCount <= 1) {
      return super.download(url, destination, options)
    }
    // 探测总大小与 Range 支持
    const probe = await this.probe(url, options.headers)
    if (probe == null || !probe.acceptRanges || probe.size < MIN_PARALLEL_SIZE) {
      return super.download(url, destination, options)
    }

    return this.parallelDownload(url, destination, options, probe.size)
  }

  /**
   * 探测：发 Range: bytes=0-0 请求，根据响应判断总大小与 Range 支持。
   * 支持 Range → 206 + Content-Range: bytes 0-0/total；不支持 → 200 + Content-Length。
   * 失败返回 null（调用方回退单连接）。
   */
  private async probe(url: URL, headers?: import('node:http').OutgoingHttpHeaders | null): Promise<ProbeResult | null> {
    return await new Promise<ProbeResult | null>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (result: ProbeResult | null): void => {
        if (settled) return
        settled = true
        if (timer != null) clearTimeout(timer)
        resolve(result)
      }

      let req: ClientRequest
      try {
        req = this.createRequestWithHeaders(url, headers, { Range: 'bytes=0-0' }, (response) => {
          if (timer != null) clearTimeout(timer)
          const status = response.statusCode ?? 0
          if (status === 206) {
            const contentRange = getHeader(response, 'content-range') ?? ''
            const m = /bytes\s+0-0\/(\d+)/.exec(contentRange)
            if (m) {
              finish({ size: Number(m[1]), acceptRanges: true })
            } else {
              finish(null)
            }
          } else if (status === 200) {
            const length = Number(getHeader(response, 'content-length') ?? '0')
            finish({ size: length, acceptRanges: false })
          } else {
            finish(null)
          }
          ;(response as unknown as { destroy: () => void }).destroy()
        })
      } catch {
        finish(null)
        return
      }

      req.on('error', () => finish(null))
      timer = setTimeout(() => {
        try { req.abort() } catch { /* ignore */ }
        finish(null)
      }, REQUEST_TIMEOUT)
      req.end()
    })
  }

  /**
   * 并行分块下载：把文件切成 N 段，每段一个带 Range 的 net.request，
   * 写入同一文件句柄的对应偏移（pwrite），聚合进度，完成后 sha512 校验。
   */
  private async parallelDownload(
    url: URL,
    destination: string,
    options: DownloadOptions,
    total: number,
  ): Promise<string> {
    const chunkSize = Math.ceil(total / this.parallelCount)
    const chunks: ChunkTask[] = []
    for (let i = 0; i < this.parallelCount; i++) {
      const start = i * chunkSize
      if (start >= total) break
      const end = Math.min(total - 1, start + chunkSize - 1)
      chunks.push({ start, end })
    }

    const cancellationToken = options.cancellationToken

    // ===== 共享状态（run 与取消/回退路径共用）=====
    const startTime = Date.now()
    let fileHandle: import('node:fs/promises').FileHandle | null = null
    const activeRequests = new Set<ClientRequest>()
    let cancelled = false
    let failed = false
    let completed = 0
    let transferred = 0
    let lastTransferred = 0
    let lastProgressAt = 0

    const abortAll = (): void => {
      for (const r of activeRequests) {
        try { r.abort() } catch { /* ignore */ }
      }
      activeRequests.clear()
    }

    const emitProgress = (force = false): void => {
      if (options.onProgress == null) return
      const now = Date.now()
      if (!force && now - lastProgressAt < PROGRESS_THROTTLE_MS) return
      lastProgressAt = now
      const elapsed = Math.max(1, now - startTime)
      const info: ProgressInfo = {
        total,
        delta: transferred - lastTransferred,
        transferred,
        percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 100,
        bytesPerSecond: Math.floor(transferred / (elapsed / 1000)),
      }
      lastTransferred = transferred
      options.onProgress(info)
    }

    const cleanup = async (): Promise<void> => {
      abortAll()
      if (fileHandle != null) {
        await fileHandle.close().catch(() => { /* ignore */ })
        fileHandle = null
      }
      await fs.unlink(destination).catch(() => { /* ignore */ })
    }

    const settle = deferred<string>()

    const finishOk = (): void => {
      void (async () => {
        try {
          await fileHandle?.sync()
          await fileHandle?.close()
          fileHandle = null
          emitProgress(true) // 补发最终进度
          await this.verifySha512(destination, options.sha512)
          settle.resolve(destination)
        } catch (err) {
          await cleanup()
          settle.reject(err instanceof Error ? err : new Error(String(err)))
        }
      })()
    }

    const finishFail = (err: Error): void => {
      if (failed || cancelled) return
      failed = true
      void cleanup().then(() => settle.reject(err))
    }

    /** 非 206（服务器忽略 Range / 重定向丢 Range）→ 清理后回退单连接 */
    const fallbackToSingle = (): void => {
      if (failed || cancelled) return
      failed = true
      void cleanup().then(() => {
        super.download(url, destination, options)
          .then((result) => settle.resolve(result))
          .catch((err: Error) => settle.reject(err))
      })
    }

    const checkDone = (): void => {
      if (failed || cancelled || completed !== chunks.length) return
      finishOk()
    }

    const runChunk = (chunk: ChunkTask): void => {
      let writtenInChunk = 0
      // 每段串行写队列：同一段的 data 事件必须按序写入对应偏移
      let writeChain = Promise.resolve()
      let idleTimer: ReturnType<typeof setTimeout> | null = null

      const clearIdleTimer = (): void => {
        if (idleTimer != null) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
      }

      const resetIdleTimer = (): void => {
        clearIdleTimer()
        idleTimer = setTimeout(() => {
          try { req.abort() } catch { /* ignore */ }
          finishFail(new Error('下载段空闲超时'))
        }, REQUEST_TIMEOUT)
      }

      let req: ClientRequest
      try {
        req = this.createRequestWithHeaders(
          url,
          options.headers,
          { Range: `bytes=${chunk.start}-${chunk.end}` },
          (response) => {
            const status = response.statusCode ?? 0
            if (status !== 206) {
              ;(response as unknown as { destroy: () => void }).destroy()
              fallbackToSingle()
              return
            }
            // 进入正文：从第一个数据开始 idle 计时
            resetIdleTimer()
            response.on('data', (chunkData: Buffer) => {
              if (cancelled || failed) return
              resetIdleTimer()
              // 写入任务：position 在任务执行时计算（串行链保证 writtenInChunk 已是最新累计值），
              // 避免高速网络下多个 data 事件用陈旧偏移相互覆盖
              writeChain = writeChain
                .then(async () => {
                  if (fileHandle == null || cancelled || failed) return
                  const position = chunk.start + writtenInChunk
                  const { bytesWritten } = await fileHandle.write(chunkData, 0, chunkData.length, position)
                  writtenInChunk += bytesWritten
                  transferred += bytesWritten
                  emitProgress()
                })
                .catch((err: unknown) => finishFail(err instanceof Error ? err : new Error(String(err))))
            })
            response.on('end', () => {
              if (cancelled || failed) return
              clearIdleTimer()
              void writeChain.then(() => {
                if (cancelled || failed) return
                completed++
                checkDone()
              })
            })
            response.on('error', (err: Error) => {
              clearIdleTimer()
              finishFail(err)
            })
          },
        )
      } catch (err) {
        finishFail(err instanceof Error ? err : new Error(String(err)))
        return
      }

      activeRequests.add(req)
      req.on('error', (err: Error) => {
        clearIdleTimer()
        finishFail(err)
      })
      req.end()
    }

    // 预创建空文件，确保多段写入同一 inode
    fs.open(destination, 'w')
      .then((fh) => {
        fileHandle = fh
        for (const chunk of chunks) runChunk(chunk)
      })
      .catch((err: unknown) => {
        settle.reject(err instanceof Error ? err : new Error(String(err)))
      })

    // 支持取消：注册 onCancel → 置取消标志 + abort 全部段 + 清理临时文件。
    // 错误由 createPromise 内部以 CancellationError 拒绝（与 electron-updater 内部
    // instanceof CancellationError 判断一致，用户取消不会误报为更新出错）。
    if (cancellationToken == null) {
      return settle.promise
    }
    return cancellationToken.createPromise<string>((resolve, reject, onCancel) => {
      onCancel(() => {
        cancelled = true
        abortAll()
        void cleanup()
      })
      settle.promise.then(resolve).catch((err: Error) => reject(err))
    })
  }

  /** 校验整个文件的 sha512（流式计算，避免大文件全量读入内存；支持 base64/hex） */
  private async verifySha512(filePath: string, expected?: string | null): Promise<void> {
    if (expected == null || expected.length === 0) return
    const hash = createHash('sha512')
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath)
      stream.on('data', (chunk: Buffer) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', resolve)
    })
    const actual = hash.digest(expected.length === 128 && !expected.includes('+') && !expected.includes('Z') && !expected.includes('=') ? 'hex' : 'base64')
    if (actual !== expected) {
      throw newError(
        `sha512 checksum mismatch, expected ${expected}, got ${actual}`,
        'ERR_CHECKSUM_MISMATCH',
      )
    }
  }

  /** 构造带自定义头（合并 Range）的请求；redirect: 'follow' 自动跟随并保留 Range */
  private createRequestWithHeaders(
    url: URL,
    headers: import('node:http').OutgoingHttpHeaders | null | undefined,
    extraHeaders: Record<string, string>,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest {
    const requestOptions: Record<string, unknown> = {
      headers: { ...(headers ?? {}), ...extraHeaders },
      redirect: 'follow',
    }
    configureRequestUrl(url, requestOptions)
    configureRequestOptions(requestOptions)
    return this.createRequest(requestOptions, callback)
  }
}

/** 简单 Promise 延迟对象 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 安全读取响应头（Electron IncomingMessage headers 大小写不定） */
function getHeader(response: IncomingMessage, name: string): string | undefined {
  const headers = response.headers as Record<string, unknown> | undefined
  if (headers == null) return undefined
  const direct = headers[name]
  if (typeof direct === 'string') return direct
  if (typeof direct === 'number') return String(direct)
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) {
      return typeof v === 'string' ? v : String(v)
    }
  }
  return undefined
}
