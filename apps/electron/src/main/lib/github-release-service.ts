/**
 * GitHub Release 服务
 *
 * 从 GitHub API 获取项目的发布日志（Release Notes）
 * 支持按仓库（官方 / Ch'iVerve 专用构建）分别拉取，缓存按仓库隔离。
 */

import type {
  GitHubRelease,
  GitHubReleaseListOptions,
  GitHubRepoRef,
} from '@proma/shared'
import {
  CHIVERVE_GITHUB_REPO,
} from '@proma/shared'

/** GitHub API 基础 URL */
const GITHUB_API_BASE = 'https://api.github.com'

/** 默认仓库：Ch'iVerve 专用构建（与 electron-builder.yml 自动更新源一致） */
const GITHUB_REPO: GitHubRepoRef = CHIVERVE_GITHUB_REPO

/** 仓库 key：owner/repo（用于缓存隔离） */
function repoKey(repo?: GitHubRepoRef): string {
  const r = repo ?? GITHUB_REPO
  return `${r.owner}/${r.repo}`
}

/** Release 列表缓存（按仓库隔离） */
interface ReleaseCache {
  data: GitHubRelease[]
  timestamp: number
}

const releaseCacheMap = new Map<string, ReleaseCache>()

/** 单个 Release 缓存（key: `owner/repo#tag`） */
const tagCache = new Map<string, { data: GitHubRelease; timestamp: number }>()

/** 缓存有效期（30 分钟） */
const CACHE_TTL = 30 * 60 * 1000

/** Rate limit 冷却标记 */
let rateLimitUntil = 0

/**
 * 从 GitHub API 获取 releases
 *
 * @param endpoint - API 端点
 * @param repo - 目标仓库（缺省使用默认仓库）
 * @returns Release 数据
 */
async function fetchFromGitHub<T>(endpoint: string, repo?: GitHubRepoRef): Promise<T> {
  // Rate limit 冷却期内直接跳过
  if (Date.now() < rateLimitUntil) {
    throw new Error('GitHub API 请求过于频繁，请稍后再试')
  }

  const r = repo ?? GITHUB_REPO
  const url = `${GITHUB_API_BASE}/repos/${r.owner}/${r.repo}${endpoint}`

  console.log(`[GitHub Release] 正在请求: ${url}`)

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Proma-Desktop-App',
    },
  })

  if (response.status === 403 || response.status === 429) {
    // Rate limited — 冷却 15 分钟
    rateLimitUntil = Date.now() + 15 * 60 * 1000
    throw new Error('GitHub API 请求过于频繁，请 15 分钟后重试')
  }

  if (!response.ok) {
    throw new Error(
      `GitHub API 请求失败 (${response.status})，请检查网络连接后重试`
    )
  }

  return response.json() as Promise<T>
}

/**
 * 获取最新的 Release
 *
 * @param options - 可选：目标仓库
 * @returns 最新的 Release，如果没有则返回 null
 */
export async function getLatestRelease(options: { repo?: GitHubRepoRef } = {}): Promise<GitHubRelease | null> {
  try {
    const release = await fetchFromGitHub<GitHubRelease>('/releases/latest', options.repo)
    console.log(`[GitHub Release] 获取最新 Release: v${release.tag_name} (${repoKey(options.repo)})`)
    return release
  } catch (error) {
    console.error('[GitHub Release] 获取最新 Release 失败:', error)
    return null
  }
}

/**
 * 获取 Release 列表
 *
 * @param options - 查询选项（可指定目标仓库）
 * @returns Release 列表
 */
export async function listReleases(
  options: GitHubReleaseListOptions = {}
): Promise<GitHubRelease[]> {
  const {
    perPage = 10,
    page = 1,
    includePrerelease = false,
    repo,
  } = options
  const key = repoKey(repo)

  try {
    // 检查缓存（仅第一页）
    if (page === 1) {
      const cachedEntry = releaseCacheMap.get(key)
      if (cachedEntry && Date.now() - cachedEntry.timestamp < CACHE_TTL) {
        console.log(`[GitHub Release] 使用缓存的 Release 列表 (${key})`)
        const filtered = includePrerelease
          ? cachedEntry.data
          : cachedEntry.data.filter(r => !r.prerelease && !r.draft)
        return filtered.slice(0, perPage)
      }
    }

    // 构建查询参数
    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
    })

    const releases = await fetchFromGitHub<GitHubRelease[]>(
      `/releases?${params.toString()}`,
      repo,
    )

    console.log(`[GitHub Release] 获取到 ${releases.length} 个 Releases (${key})`)

    // 过滤草稿和预发布版本（如果需要）
    const filtered = includePrerelease
      ? releases
      : releases.filter(r => !r.prerelease && !r.draft)

    // 更新缓存（仅第一页）
    if (page === 1) {
      releaseCacheMap.set(key, {
        data: releases,
        timestamp: Date.now(),
      })
    }

    return filtered
  } catch (error) {
    console.error('[GitHub Release] 获取 Release 列表失败:', error)
    // 如果有缓存，即使过期也返回
    const cachedEntry = releaseCacheMap.get(key)
    if (cachedEntry) {
      console.log(`[GitHub Release] API 请求失败，使用过期缓存 (${key})`)
      const filtered = includePrerelease
        ? cachedEntry.data
        : cachedEntry.data.filter(r => !r.prerelease && !r.draft)
      return filtered.slice(0, perPage)
    }
    // 没有缓存时抛出异常，让前端知道加载失败
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * 根据标签名获取指定的 Release
 *
 * @param tag - 标签名（版本号）
 * @param options - 可选：目标仓库
 * @returns 指定的 Release，如果没有则返回 null
 */
export async function getReleaseByTag(tag: string, options: { repo?: GitHubRepoRef } = {}): Promise<GitHubRelease | null> {
  const key = `${repoKey(options.repo)}#${tag}`
  try {
    // 检查缓存
    const cached = tagCache.get(key)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data
    }

    const release = await fetchFromGitHub<GitHubRelease>(
      `/releases/tags/${tag}`,
      options.repo,
    )
    console.log(`[GitHub Release] 获取 Release: ${tag} (${repoKey(options.repo)})`)

    tagCache.set(key, { data: release, timestamp: Date.now() })
    return release
  } catch (error) {
    console.error(`[GitHub Release] 获取 Release ${tag} 失败:`, error)
    // 返回过期缓存
    const cached = tagCache.get(key)
    if (cached) return cached.data
    return null
  }
}

/**
 * 清除缓存
 */
export function clearReleaseCache(): void {
  releaseCacheMap.clear()
  console.log('[GitHub Release] 缓存已清除')
}
