/**
 * GitHub Release 相关类型定义
 */

/** GitHub 仓库引用 */
export interface GitHubRepoRef {
  owner: string
  repo: string
}

/** 官方开源仓库（proma-ai/Proma） */
export const OFFICIAL_GITHUB_REPO: GitHubRepoRef = {
  owner: 'proma-ai',
  repo: 'Proma',
}

/** Ch'iVerve 专用构建发布仓库（自动更新源） */
export const CHIVERVE_GITHUB_REPO: GitHubRepoRef = {
  owner: 'climashscape',
  repo: 'Proma',
}

/** GitHub Release 资源（简化版） */
export interface GitHubRelease {
  /** Release ID */
  id: number
  /** 标签名（版本号） */
  tag_name: string
  /** Release 名称 */
  name: string
  /** 发布说明（Markdown 格式） */
  body: string
  /** 是否为草稿 */
  draft: boolean
  /** 是否为预发布版本 */
  prerelease: boolean
  /** 创建时间 */
  created_at: string
  /** 发布时间 */
  published_at: string
  /** Release HTML URL */
  html_url: string
}

/** GitHub Release 列表查询选项 */
export interface GitHubReleaseListOptions {
  /** 每页数量（默认 10） */
  perPage?: number
  /** 页码（默认 1） */
  page?: number
  /** 是否包含草稿和预发布版本（默认 false） */
  includePrerelease?: boolean
  /** 目标仓库；缺省时使用当前构建配置的仓库 */
  repo?: GitHubRepoRef
  /** 强制跳过缓存重新拉取（刷新按钮使用） */
  forceRefresh?: boolean
}

/** GitHub Release 单条查询选项（最新 / 按 tag） */
export interface GitHubReleaseQueryOptions {
  /** 目标仓库；缺省时使用当前构建配置的仓库 */
  repo?: GitHubRepoRef
}

/** GitHub Release IPC 通道常量 */
export const GITHUB_RELEASE_IPC_CHANNELS = {
  /** 获取最新 Release */
  GET_LATEST_RELEASE: 'github-release:get-latest',
  /** 获取 Release 列表 */
  LIST_RELEASES: 'github-release:list',
  /** 获取指定版本的 Release */
  GET_RELEASE_BY_TAG: 'github-release:get-by-tag',
} as const
