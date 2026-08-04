/**
 * git-diff-service 集成测试 — 用临时 git 仓库验证仓库发现 / worktree 枚举 / 聚合变更。
 *
 * 每个用例使用独立临时仓库，避免共享缓存与状态污染。
 * 依赖真实 git 可执行文件（与运行时一致），测试前请确保 git 可用。
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findAllGitRoots, getRepoChanges, getWorktreeChanges, invalidateGitDiffCache, listRepos } from './git-diff-service'

let cleanupDirs: string[] = []

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'gdser-'))
  cleanupDirs.push(root)
  const run = (args: string[]) => execSync(`git ${args.join(' ')}`, { cwd: root, stdio: 'pipe' })
  run(['init', '-b', 'main'])
  run(['config', 'user.email', 'test@test.com'])
  run(['config', 'user.name', 'test'])
  writeFileSync(join(root, 'a.txt'), 'hello\n')
  run(['add', '.'])
  run(['commit', '-m', 'init'])
  return root
}

afterEach(() => {
  invalidateGitDiffCache()
  for (const dir of cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
  cleanupDirs = []
})

describe('git-diff-service 仓库发现与聚合', () => {
  it('findAllGitRoots 能发现仓库根', async () => {
    const root = makeRepo()
    const roots = await findAllGitRoots(root)
    expect(roots).toContain(root.replace(/\\/g, '/'))
  })

  it('listRepos 列出仓库（含主 worktree）', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'a.txt'), 'hello world\n') // 未提交改动
    const repos = await listRepos(root)
    expect(repos.length).toBe(1)
    expect(repos[0]!.name).toBe(root.split(/[\\/]/).pop() ?? '')
    expect(repos[0]!.branch).toBe('main')
    expect(repos[0]!.worktreeCount).toBe(1)
    expect(repos[0]!.worktrees[0]!.isMain).toBe(true)
  })

  it('listRepos 枚举额外 worktree，且新 worktree 立即可见', async () => {
    const root = makeRepo()
    execSync('git worktree add -b dev wt-dev', { cwd: root, stdio: 'pipe' })
    // 清缓存模拟跨扫描周期（worktree 列表 / 仓库列表均有 TTL）
    invalidateGitDiffCache()
    const repos = await listRepos(root)
    expect(repos.length).toBe(1)
    expect(repos[0]!.worktreeCount).toBe(2)
    const branches = repos[0]!.worktrees.map((w) => w.branch)
    expect(branches).toContain('main')
    expect(branches).toContain('dev')
  })

  it('getRepoChanges 聚合未提交改动并探测基准分支', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'a.txt'), 'hello world\n') // 未提交改动
    const repos = await listRepos(root)
    const result = await getRepoChanges(repos[0]!.repoPath)
    expect(result.isGitRepo).toBe(true)
    expect(result.worktrees.length).toBe(1)
    const files = result.worktrees[0]!.changes.files
    expect(files.some((f) => f.filePath === 'a.txt' && f.status === 'modified')).toBe(true)
    // 无远端时回退到本地 main 作为基准
    expect(result.baseBranch).toBe('main')
  })

  it('getWorktreeChanges 返回自动探测的基准分支', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'a.txt'), 'hello world\n')
    const result = await getWorktreeChanges(root)
    expect(result.isGitRepo).toBe(true)
    expect(result.baseBranch).toBe('main')
    expect(result.files.some((f) => f.filePath === 'a.txt')).toBe(true)
  })
})
