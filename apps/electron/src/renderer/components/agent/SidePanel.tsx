/**
 * SidePanel — Agent 侧面板容器
 *
 * 直接展示文件浏览器，默认打开状态。
 * 切换按钮在面板关闭时显示活动指示点。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { X, ExternalLink, ChevronRight, MoreHorizontal, FolderSearch, Pencil, FolderInput, MessageSquarePlus, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { FileBrowser, FileDropZone, FileTypeIcon, FileSearchBar, computeRevealAncestors, isPathUnderRoot, computeTreeRowLayout, AncestorGuides, STICKY_ROW_BASE_CLASS, canBeSticky } from '@/components/file-browser'
import { DiffPanelTabBar } from '@/components/diff/DiffPanelTabBar'
import { DiffChangesList } from '@/components/diff/DiffChangesList'
import { ChatView } from '@/components/chat/ChatView'
import {
  agentSidePanelOpenAtom,
  agentFileSourceFilterMapAtom,
  workspaceFilesVersionAtom,
  currentAgentWorkspaceIdAtom,
  agentWorkspacesAtom,
  agentSessionsAtom,
  agentAttachedDirectoriesMapAtom,
  agentAttachedFilesMapAtom,
  workspaceAttachedDirectoriesMapAtom,
  workspaceAttachedFilesMapAtom,
  agentPendingFilesAtomFamily,
  agentDiffRefreshVersionAtom,
  agentNonGitFileChangesAtom,
  agentFileChangesCurrentRunAtom,
  fileBrowserAutoRevealAtom,
  agentSelectedWorktreeAtom,
} from '@/atoms/agent-atoms'
import type { AgentSidePanelTab, AgentFileSourceFilter } from '@/atoms/agent-atoms'
import { agentSideChatMapAtom, conversationsAtom } from '@/atoms/chat-atoms'
import { draftSessionIdsAtom } from '@/atoms/draft-session-atoms'
import { useOpenSideChat } from '@/hooks/useOpenSideChat'
import { interfaceVariantAtom } from '@/atoms/theme'
import { previewFileMapAtom } from '@/atoms/preview-atoms'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { detectIsWindows } from '@/lib/platform'
import { formatRelativeUpdatedAt } from '@/lib/time-format'
import type { FileEntry, AgentPendingFile, ConversationMeta } from '@proma/shared'
import { setFilePanelDragData, getMediaTypeFromFilename, dispatchInsertFileMention } from '@/lib/file-panel-drag'

// ===== 常量 =====

/** 右侧「查看现有问答」列表最多展示的会话数 */
const VIEWABLE_CONVERSATIONS_LIMIT = 30

function getPathBasename(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath
}

function getPathDirname(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, '')
  const separatorIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : ''
}

function joinPath(parentDir: string, name: string): string {
  const separator = parentDir.includes('\\') && !parentDir.includes('/') ? '\\' : '/'
  return parentDir ? `${parentDir}${separator}${name}` : name
}

interface SidePanelProps {
  sessionId: string
  sessionPath: string | null
  activeTab: AgentSidePanelTab
  onTabChange: (tab: AgentSidePanelTab) => void
  width?: number
}

export function SidePanel({ sessionId, sessionPath, activeTab, onTabChange, width = 280 }: SidePanelProps): React.ReactElement {
  // per-session 侧面板状态（默认打开）
  const [isOpen, setIsOpen] = useAtom(agentSidePanelOpenAtom)
  const isWindows = React.useMemo(() => detectIsWindows(), [])

  // Tab 系统
  const previewFileMap = useAtomValue(previewFileMapAtom)
  const selectedFilePath = previewFileMap.get(sessionId)?.filePath

  const openPreview = useOpenPreview()

  // 用 ref 存 basePaths 相关值，避免声明顺序问题
  const basePathsRef = React.useRef<string[]>([])

  const handleFilePreview = React.useCallback((filePath: string) => {
    const bp = basePathsRef.current
    openPreview(sessionId, {
      filePath,
      previewOnly: true,
      basePaths: bp.length > 0 ? bp : undefined,
    })
  }, [sessionId, openPreview])

  // Worktree 选择状态（仅用于 diff 文件点击时传递 baseRef，选取逻辑已下沉至 DiffChangesList）
  const selectedWorktreeMap = useAtomValue(agentSelectedWorktreeAtom)
  const selectedWorktreePath = selectedWorktreeMap.get(sessionId) ?? null

  const handleDiffFileClick = React.useCallback((filePath: string, _isUntracked: boolean, gitRoot?: string) => {
    openPreview(sessionId, {
      filePath,
      dirPath: sessionPath || undefined,
      gitRoot,
      baseRef: selectedWorktreePath ? 'origin/main' : undefined,
    })
  }, [openPreview, sessionId, sessionPath, selectedWorktreePath])

  // 动画标志：isOpen 变化时启用过渡动画，切换会话时即时显示
  const prevIsOpenRef = React.useRef(isOpen)
  const prevSessionIdRef = React.useRef(sessionId)
  const shouldAnimate = prevSessionIdRef.current === sessionId && prevIsOpenRef.current !== isOpen
  React.useEffect(() => {
    prevIsOpenRef.current = isOpen
    prevSessionIdRef.current = sessionId
  })

  const filesVersion = useAtomValue(workspaceFilesVersionAtom)
  const setFilesVersion = useSetAtom(workspaceFilesVersionAtom)
  const diffRefreshVersionMap = useAtomValue(agentDiffRefreshVersionAtom)
  const diffRefreshVersion = diffRefreshVersionMap.get(sessionId) ?? 0
  const nonGitFileChangesMap = useAtomValue(agentNonGitFileChangesAtom)
  const nonGitFileChanges = nonGitFileChangesMap.get(sessionId) ?? []
  const fileChangesCurrentRunMap = useAtomValue(agentFileChangesCurrentRunAtom)
  const fileChangesCurrentRunId = fileChangesCurrentRunMap.get(sessionId)

  // 文件面板必须跟随当前会话归属的项目。仅在会话元数据尚未加载时回退全局选择，
  // 避免用户切换项目列表但仍查看旧会话时读写错误项目根目录。
  const selectedWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const currentWorkspaceId = sessions.find((session) => session.id === sessionId)?.workspaceId ?? selectedWorkspaceId
  const currentWorkspace = workspaces.find((workspace) => workspace.id === currentWorkspaceId)
  const workspaceSlug = currentWorkspace?.slug ?? null
  const projectRootPath = currentWorkspace?.projectRootPath ?? null
  const isProjectRootUnavailable = Boolean(
    currentWorkspace?.projectRootPath
    && currentWorkspace.projectRootStatus
    && currentWorkspace.projectRootStatus !== 'available',
  )
  const fileAccess = React.useMemo(() => ({ sessionId }), [sessionId])

  // 附加目录列表（会话级）
  const attachedDirsMap = useAtomValue(agentAttachedDirectoriesMapAtom)
  const setAttachedDirsMap = useSetAtom(agentAttachedDirectoriesMapAtom)
  const attachedDirs = attachedDirsMap.get(sessionId) ?? []
  const attachedFilesMap = useAtomValue(agentAttachedFilesMapAtom)
  const setAttachedFilesMap = useSetAtom(agentAttachedFilesMapAtom)
  const attachedFiles = attachedFilesMap.get(sessionId) ?? []

  // 附加目录列表（工作区级）
  const wsAttachedDirsMap = useAtomValue(workspaceAttachedDirectoriesMapAtom)
  const setWsAttachedDirsMap = useSetAtom(workspaceAttachedDirectoriesMapAtom)
  const wsAttachedDirs = currentWorkspaceId ? (wsAttachedDirsMap.get(currentWorkspaceId) ?? []) : []
  const wsAttachedFilesMap = useAtomValue(workspaceAttachedFilesMapAtom)
  const setWsAttachedFilesMap = useSetAtom(workspaceAttachedFilesMapAtom)
  const wsAttachedFiles = currentWorkspaceId ? (wsAttachedFilesMap.get(currentWorkspaceId) ?? []) : []

  const extraPathsMemo = React.useMemo(
    () => [...attachedDirs, ...wsAttachedDirs],
    [attachedDirs, wsAttachedDirs]
  )

  const fileAccessPathsMemo = React.useMemo(
    () => [...extraPathsMemo, ...attachedFiles, ...wsAttachedFiles],
    [extraPathsMemo, attachedFiles, wsAttachedFiles]
  )

  // 加载工作区级附加目录
  React.useEffect(() => {
    if (!workspaceSlug || !currentWorkspaceId) return
    window.electronAPI.getWorkspaceDirectories(workspaceSlug)
      .then((dirs) => {
        setWsAttachedDirsMap((prev) => {
          const map = new Map(prev)
          map.set(currentWorkspaceId, dirs)
          return map
        })
      })
      .catch(console.error)
  }, [workspaceSlug, currentWorkspaceId, setWsAttachedDirsMap])

  // 加载工作区级附加文件
  React.useEffect(() => {
    if (!workspaceSlug || !currentWorkspaceId) return
    window.electronAPI.getWorkspaceAttachedFiles(workspaceSlug)
      .then((files) => {
        setWsAttachedFilesMap((prev) => {
          const map = new Map(prev)
          map.set(currentWorkspaceId, files)
          return map
        })
      })
      .catch(console.error)
  }, [workspaceSlug, currentWorkspaceId, setWsAttachedFilesMap])

  // === 会话级：移除既有附加项 ===

  const handleDetachDirectory = React.useCallback(async (dirPath: string) => {
    try {
      const updated = await window.electronAPI.detachDirectory({ sessionId, directoryPath: dirPath })
      setAttachedDirsMap((prev) => {
        const map = new Map(prev)
        if (updated.length > 0) { map.set(sessionId, updated) } else { map.delete(sessionId) }
        return map
      })
    } catch (error) {
      console.error('[SidePanel] 移除附加目录失败:', error)
    }
  }, [sessionId, setAttachedDirsMap])

  const handleDetachFile = React.useCallback(async (filePath: string) => {
    try {
      const updated = await window.electronAPI.detachFile({ sessionId, filePath })
      setAttachedFilesMap((prev) => {
        const map = new Map(prev)
        if (updated.length > 0) { map.set(sessionId, updated) } else { map.delete(sessionId) }
        return map
      })
    } catch (error) {
      console.error('[SidePanel] 移除附加文件失败:', error)
    }
  }, [sessionId, setAttachedFilesMap])

  const attachSessionDir = React.useCallback(async (dirPath: string) => {
    const updated = await window.electronAPI.attachDirectory({ sessionId, directoryPath: dirPath })
    setAttachedDirsMap((prev) => {
      const map = new Map(prev)
      map.set(sessionId, updated)
      return map
    })
  }, [sessionId, setAttachedDirsMap])

  const handleAttachSessionFolder = React.useCallback(async () => {
    try {
      const result = await window.electronAPI.openFolderDialog()
      if (result) await attachSessionDir(result.path)
    } catch (error) {
      console.error('[SidePanel] 附加会话文件夹失败:', error)
    }
  }, [attachSessionDir])

  const handleSessionFoldersDropped = React.useCallback(async (folderPaths: string[]) => {
    for (const dirPath of folderPaths) {
      try { await attachSessionDir(dirPath) } catch (error) {
        console.error('[SidePanel] 拖拽附加会话文件夹失败:', error)
      }
    }
  }, [attachSessionDir])

  const attachSessionFile = React.useCallback(async (filePath: string) => {
    const updated = await window.electronAPI.attachFile({ sessionId, filePath })
    setAttachedFilesMap((prev) => {
      const map = new Map(prev)
      map.set(sessionId, updated)
      return map
    })
  }, [sessionId, setAttachedFilesMap])

  const handleSessionFilesAttached = React.useCallback(async (filePaths: string[]) => {
    for (const filePath of filePaths) {
      try { await attachSessionFile(filePath) } catch (error) {
        console.error('[SidePanel] 附加会话文件失败:', error)
      }
    }
  }, [attachSessionFile])

  // === 工作区级：附加/移除目录 ===

  const attachWorkspaceDir = React.useCallback(async (dirPath: string) => {
    if (!workspaceSlug || !currentWorkspaceId) return
    const updated = await window.electronAPI.attachWorkspaceDirectory({ workspaceSlug, directoryPath: dirPath })
    setWsAttachedDirsMap((prev) => {
      const map = new Map(prev)
      map.set(currentWorkspaceId, updated)
      return map
    })
  }, [workspaceSlug, currentWorkspaceId, setWsAttachedDirsMap])

  const handleAttachWorkspaceFolder = React.useCallback(async () => {
    try {
      const result = await window.electronAPI.openFolderDialog()
      if (result) await attachWorkspaceDir(result.path)
    } catch (error) {
      console.error('[SidePanel] 附加项目文件夹失败:', error)
    }
  }, [attachWorkspaceDir])

  const handleWorkspaceFoldersDropped = React.useCallback(async (folderPaths: string[]) => {
    for (const dirPath of folderPaths) {
      try { await attachWorkspaceDir(dirPath) } catch (error) {
        console.error('[SidePanel] 拖拽附加项目文件夹失败:', error)
      }
    }
  }, [attachWorkspaceDir])

  const handleDetachWorkspaceDirectory = React.useCallback(async (dirPath: string) => {
    if (!workspaceSlug || !currentWorkspaceId) return
    try {
      const updated = await window.electronAPI.detachWorkspaceDirectory({ workspaceSlug, directoryPath: dirPath })
      setWsAttachedDirsMap((prev) => {
        const map = new Map(prev)
        if (updated.length > 0) { map.set(currentWorkspaceId, updated) } else { map.delete(currentWorkspaceId) }
        return map
      })
    } catch (error) {
      console.error('[SidePanel] 移除工作区附加目录失败:', error)
    }
  }, [workspaceSlug, currentWorkspaceId, setWsAttachedDirsMap])


  const attachWorkspaceFile = React.useCallback(async (filePath: string) => {
    if (!workspaceSlug || !currentWorkspaceId) return
    const updated = await window.electronAPI.attachWorkspaceFile({ workspaceSlug, filePath })
    setWsAttachedFilesMap((prev) => {
      const map = new Map(prev)
      map.set(currentWorkspaceId, updated)
      return map
    })
  }, [workspaceSlug, currentWorkspaceId, setWsAttachedFilesMap])

  const handleWorkspaceFilesAttached = React.useCallback(async (filePaths: string[]) => {
    for (const filePath of filePaths) {
      try { await attachWorkspaceFile(filePath) } catch (error) {
        console.error('[SidePanel] 附加项目文件失败:', error)
      }
    }
  }, [attachWorkspaceFile])

  const handleDetachWorkspaceFile = React.useCallback(async (filePath: string) => {
    if (!workspaceSlug || !currentWorkspaceId) return
    try {
      const updated = await window.electronAPI.detachWorkspaceFile({ workspaceSlug, filePath })
      setWsAttachedFilesMap((prev) => {
        const map = new Map(prev)
        if (updated.length > 0) { map.set(currentWorkspaceId, updated) } else { map.delete(currentWorkspaceId) }
        return map
      })
    } catch (error) {
      console.error('[SidePanel] 移除工作区附加文件失败:', error)
    }
  }, [workspaceSlug, currentWorkspaceId, setWsAttachedFilesMap])

  // 文件上传完成后递增版本号，触发 FileBrowser 刷新
  const handleFilesUploaded = React.useCallback(() => {
    setFilesVersion((prev) => prev + 1)
  }, [setFilesVersion])

  // 添加文件到聊天
  const pendingFiles = useAtomValue(agentPendingFilesAtomFamily(sessionId))
  const setPendingFiles = useSetAtom(agentPendingFilesAtomFamily(sessionId))
  const handleAddToChat = React.useCallback((entry: FileEntry) => {
    // 先在 setter 外部检查去重，避免在 updater 函数内执行不可逆副作用
    if (pendingFiles.some((f) => f.sourcePath === entry.path)) return

    const pending: AgentPendingFile = {
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filename: entry.name,
      mediaType: getMediaTypeFromFilename(entry.name),
      size: entry.size ?? 0,
      sourcePath: entry.path,
    }

    // 有 sourcePath 的文件发送时直接引用原路径，不需要存 base64
    setPendingFiles((prev) => [...prev, pending])
  }, [pendingFiles, setPendingFiles])


  // 工作区文件目录路径
  const [workspaceFilesPath, setWorkspaceFilesPath] = React.useState<string | null>(null)
  React.useEffect(() => {
    let disposed = false

    // 在相同 slug 重新关联本地目录时，先清除旧路径，避免旧目录短暂继续可见或被使用。
    setWorkspaceFilesPath(null)
    if (!workspaceSlug) return

    window.electronAPI.getWorkspaceFilesPath(workspaceSlug)
      .then((path) => {
        if (!disposed) setWorkspaceFilesPath(path)
      })
      .catch(() => {
        if (!disposed) setWorkspaceFilesPath(null)
      })

    return () => {
      disposed = true
    }
  }, [workspaceSlug, projectRootPath])

  const worktreeRepoPathsMemo = React.useMemo(
    () => [sessionPath, workspaceFilesPath, ...extraPathsMemo].filter(Boolean) as string[],
    [sessionPath, workspaceFilesPath, extraPathsMemo]
  )

  const fileSourceFilterMap = useAtomValue(agentFileSourceFilterMapAtom)
  const setFileSourceFilterMap = useSetAtom(agentFileSourceFilterMapAtom)
  const fileSourceFilter = fileSourceFilterMap[sessionId] ?? 'session'
  const setFileSourceFilter = React.useCallback((source: AgentFileSourceFilter) => {
    setFileSourceFilterMap((prev) => {
      if (prev[sessionId] === source) return prev
      return { ...prev, [sessionId]: source }
    })
  }, [sessionId, setFileSourceFilterMap])
  const showSessionFiles = fileSourceFilter === 'session'
  const showProjectFiles = fileSourceFilter === 'project'

  const visibleFileRoots = React.useMemo(() => [
    ...(showProjectFiles && workspaceFilesPath && !isProjectRootUnavailable ? [{ path: workspaceFilesPath, scope: 'project' as const }] : []),
    ...(showSessionFiles && sessionPath ? [{ path: sessionPath, scope: 'session' as const }] : []),
  ], [showProjectFiles, workspaceFilesPath, isProjectRootUnavailable, showSessionFiles, sessionPath])

  // Files 将会话与项目文件放在同一视图；FileBrowser 自己处理对应根目录的自动定位。
  // RightSidePanel 完全由用户控制，不因 Agent 文件变更自动打开。

  // 同步 basePaths ref（供 handleFilePreview 使用，避免 hooks 声明顺序问题）
  basePathsRef.current = [sessionPath, workspaceFilesPath, ...fileAccessPathsMemo].filter(Boolean) as string[]
  const hasSessionAttachedItems = attachedDirs.length > 0 || attachedFiles.length > 0
  const hasWorkspaceAttachedItems = wsAttachedDirs.length > 0 || wsAttachedFiles.length > 0
  const hasVisibleSessionAttachedItems = showSessionFiles && hasSessionAttachedItems
  const hasVisibleWorkspaceAttachedItems = showProjectFiles && hasWorkspaceAttachedItems
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  const sideChatMap = useAtomValue(agentSideChatMapAtom)
  const setSideChatMap = useSetAtom(agentSideChatMapAtom)
  const sideChatConversationId = sideChatMap.get(sessionId) ?? null

  // === 右侧问答 Tab：查看现有对话列表 ===
  const [conversations, setConversations] = useAtom(conversationsAtom)
  const draftSessionIds = useAtomValue(draftSessionIdsAtom)
  /** 可选的现有问答对话（当前 Agent 会话的 agent-side-qa，非归档且非草稿，按更新时间倒序，最多 30 条） */
  const viewableConversations = React.useMemo(
    () => conversations
      .filter((c) =>
        c.sourceType === 'agent-side-qa'
        && c.parentAgentSessionId === sessionId
        && !c.archived
        && !draftSessionIds.has(c.id),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, VIEWABLE_CONVERSATIONS_LIMIT),
    [conversations, draftSessionIds, sessionId],
  )
  const hasViewableConversations = viewableConversations.length > 0

  // 相对时间基准：60 秒刷新一次，避免面板停留时列表时间标签过期
  const [relativeTimeNow, setRelativeTimeNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const id = window.setInterval(() => setRelativeTimeNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  /** 无问答会话时隐藏「问答」Tab；有绑定对话或可选现有对话时展示 */
  const effectiveActiveTab: AgentSidePanelTab = activeTab === 'chat' && !sideChatConversationId && !hasViewableConversations
    ? 'files'
    : activeTab

  /** 从「查看现有问答」列表选择对话并绑定为当前会话的侧边问答 */
  const handleOpenExistingChat = React.useCallback((conversationId: string) => {
    setSideChatMap((prev) => {
      const next = new Map(prev)
      next.set(sessionId, conversationId)
      return next
    })
  }, [sessionId, setSideChatMap])

  /** 在右侧面板直接新建问答对话（无选区上下文） */
  const openSideChat = useOpenSideChat({
    title: '右侧问答',
    sourceKind: 'side-panel',
    draft: null,
    errorLogPrefix: 'SidePanel',
  })

  const handleCreateSideChat = React.useCallback(async (): Promise<void> => {
    await openSideChat(sessionId, null)
  }, [openSideChat, sessionId])

  const handleCloseChatTab = React.useCallback(() => {
    setSideChatMap((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Map(prev)
      next.delete(sessionId)
      return next
    })
    if (activeTab === 'chat') {
      onTabChange('files')
    }
  }, [activeTab, onTabChange, sessionId, setSideChatMap])

  /** 删除问答对话（「查看现有问答」列表行删除按钮） */
  const handleDeleteSideChat = React.useCallback(async (conversationId: string): Promise<void> => {
    const targetTitle = conversations.find((c) => c.id === conversationId)?.title ?? conversationId
    if (!window.confirm(`确定删除问答「${targetTitle}」吗？删除后不可恢复。`)) return
    try {
      await window.electronAPI.deleteConversation(conversationId)
      setConversations((prev) => prev.filter((c) => c.id !== conversationId))
      // 若删除的是当前绑定会话，解绑并回到列表
      if (sideChatConversationId === conversationId) {
        setSideChatMap((prev) => {
          const next = new Map(prev)
          next.delete(sessionId)
          return next
        })
      }
      toast.success('已删除问答对话')
    } catch (error) {
      console.error('[SidePanel] 删除问答对话失败:', error)
      toast.error('删除问答对话失败')
    }
  }, [conversations, setConversations, setSideChatMap, sideChatConversationId, sessionId])

  // 激活态写回：无会话且无可选对话时「问答」Tab 被 effectiveActiveTab 兜底隐藏，
  // 但持久化 atom 仍停留在 chat。这里用 effect 写回 files，避免后续会话切换、
  // 全局出现新对话时视图无操作跳变（不 setState，避免渲染期写状态）。
  React.useEffect(() => {
    if (activeTab === 'chat' && !sideChatConversationId && !hasViewableConversations) {
      onTabChange('files')
    }
  }, [activeTab, sideChatConversationId, hasViewableConversations, onTabChange])


  return (
    <div
      className={cn(
        'relative z-0 h-full flex-shrink-0 overflow-hidden titlebar-drag-region bg-content-area',
        isClassic && 'rounded-2xl shadow-xl dark:shadow-md',
        shouldAnimate && 'transition-[width] duration-300 ease-in-out',
        isOpen ? '' : '!w-0',
      )}
      style={isOpen ? { width } : undefined}
    >
      {/* 面板内容 */}
      <div
        className={cn(
          'w-full h-full flex flex-col titlebar-no-drag',
          isWindows ? 'pt-[34px]' : 'pt-0',
          shouldAnimate && 'transition-opacity duration-300',
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
        >
          <DiffPanelTabBar
            activeTab={effectiveActiveTab}
            onTabChange={onTabChange}
            onClose={() => setIsOpen(false)}
            onCloseChat={handleCloseChatTab}
            showChatTab={Boolean(sideChatConversationId) || hasViewableConversations}
            isWindows={isWindows}
          />

          {effectiveActiveTab === 'chat' ? (
            sideChatConversationId ? (
              <div className="min-h-0 flex-1 overflow-hidden">
                <ChatView conversationId={sideChatConversationId} variant="side-qa" />
              </div>
            ) : (
              <div className="flex-1 min-h-0 flex flex-col">
                {/* 头部：查看现有问答 + 新建入口 */}
                <div className="flex items-center justify-between px-3 pt-2 pb-1 flex-shrink-0">
                  <span className="text-[11px] font-medium text-foreground/40 select-none">查看现有问答</span>
                  <button
                    type="button"
                    onClick={() => { void handleCreateSideChat() }}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-foreground/45 transition-colors hover:bg-foreground/[0.055] hover:text-foreground/75"
                  >
                    <Plus className="size-3" />
                    新建问答
                  </button>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-2 pb-2">
                  <div className="flex flex-col gap-0.5">
                    {viewableConversations.map((conv) => (
                      <SideChatConversationRow
                        key={conv.id}
                        conversation={conv}
                        relativeTimeNow={relativeTimeNow}
                        onSelect={handleOpenExistingChat}
                        onDelete={handleDeleteSideChat}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )
          ) : effectiveActiveTab === 'changes' ? (
            sessionPath ? (
              <DiffChangesList
                key={sessionId}
                dirPath={workspaces.find((workspace) => workspace.id === currentWorkspaceId)?.projectRootPath ?? sessionPath}
                sessionId={sessionId}
                sessionPath={sessionPath}
                workspaceFilesPath={workspaceFilesPath || undefined}
                extraPaths={fileAccessPathsMemo}
                refreshVersion={diffRefreshVersion}
                selectedFilePath={selectedFilePath}
                onFileClick={handleDiffFileClick}
                workspaceSlug={workspaceSlug || undefined}
                worktreeRepoPaths={worktreeRepoPathsMemo}
                nonGitFileChanges={nonGitFileChanges}
                currentFileChangeRunId={fileChangesCurrentRunId}
                onPlainFileClick={handleFilePreview}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">等待会话初始化...</div>
            )
          ) : effectiveActiveTab === 'files' ? (
            <div className="flex-1 min-h-0 flex flex-col pt-2 mx-2 mb-2">
              {sessionPath ? (
                <>
                  <FileSearchBar
                    workspaceFilesPath={isProjectRootUnavailable ? null : workspaceFilesPath}
                    sessionPath={sessionPath}
                    sessionAttachedDirs={attachedDirs}
                    workspaceAttachedDirs={wsAttachedDirs}
                    sourceFilter={fileSourceFilter}
                    showSessionBadge={false}
                    placeholder="搜索文件..."
                    sessionId={sessionId}
                    onFilePreview={handleFilePreview}
                  >
                    <div className="file-source-tabbar main-tabbar mt-1.5 flex h-7 border-b border-border/80" role="tablist" aria-label="文件来源">
                      <button
                        type="button"
                        role="tab"
                        className={cn(
                          'relative flex-1 h-7 px-2 text-[11px] transition-colors select-none',
                          fileSourceFilter === 'session'
                            ? 'app-tab-active text-foreground'
                            : 'app-tab-inactive text-muted-foreground hover:text-foreground',
                        )}
                        aria-selected={fileSourceFilter === 'session'}
                        onClick={() => setFileSourceFilter('session')}
                      >
                        会话文件
                      </button>
                      <button
                        type="button"
                        role="tab"
                        className={cn(
                          'relative flex-1 h-7 px-2 text-[11px] transition-colors select-none',
                          fileSourceFilter === 'project'
                            ? 'app-tab-active text-foreground'
                            : 'app-tab-inactive text-muted-foreground hover:text-foreground',
                        )}
                        aria-selected={fileSourceFilter === 'project'}
                        onClick={() => setFileSourceFilter('project')}
                      >
                        项目文件
                      </button>
                    </div>
                  </FileSearchBar>
                  <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin pt-1">
                    {/* 拖拽引用提示：引用块样式，左侧竖线 + 缩进，与下方文件列表内容左对齐 */}
                    <div className="mb-1.5 ml-4 border-l-2 border-primary/40 pl-2 text-[11px] leading-4 text-foreground/75">
                      支持拖拽文件或文件夹到输入框，实现引用
                    </div>
                    {showProjectFiles && wsAttachedFiles.length > 0 && (
                      <AttachedFilesSection
                        scope="project"
                        attachedFiles={wsAttachedFiles}
                        onDetach={handleDetachWorkspaceFile}
                        onAddToChat={handleAddToChat}
                        onFilePreview={handleFilePreview}
                        allowedPaths={basePathsRef.current}
                        sessionId={sessionId}
                      />
                    )}
                    {showProjectFiles && wsAttachedDirs.length > 0 && (
                      <AttachedDirsSection
                        scope="project"
                        attachedDirs={wsAttachedDirs}
                        onDetach={handleDetachWorkspaceDirectory}
                        refreshVersion={filesVersion}
                        onAddToChat={handleAddToChat}
                        onFilePreview={handleFilePreview}
                        allowedPaths={basePathsRef.current}
                        sessionId={sessionId}
                      />
                    )}
                    {showSessionFiles && attachedFiles.length > 0 && (
                      <AttachedFilesSection
                        scope="session"
                        showSessionBadge={false}
                        attachedFiles={attachedFiles}
                        onDetach={handleDetachFile}
                        onAddToChat={handleAddToChat}
                        onFilePreview={handleFilePreview}
                        allowedPaths={basePathsRef.current}
                        sessionId={sessionId}
                      />
                    )}
                    {showSessionFiles && attachedDirs.length > 0 && (
                      <AttachedDirsSection
                        scope="session"
                        showSessionBadge={false}
                        attachedDirs={attachedDirs}
                        onDetach={handleDetachDirectory}
                        refreshVersion={filesVersion}
                        onAddToChat={handleAddToChat}
                        onFilePreview={handleFilePreview}
                        allowedPaths={basePathsRef.current}
                        sessionId={sessionId}
                      />
                    )}
                    {showProjectFiles && isProjectRootUnavailable && (
                      <div className="mx-2 my-2 px-3 py-2 text-xs text-destructive bg-destructive/10 rounded-md">
                        本地项目根目录不可用；当前会话文件仍可访问。
                      </div>
                    )}
                    <FileBrowser
                      roots={visibleFileRoots}
                      access={fileAccess}
                      projectRootPath={isProjectRootUnavailable ? null : workspaceFilesPath}
                      showSessionBadge={false}
                      hideToolbar
                      embedded
                      hideEmpty={hasVisibleSessionAttachedItems || hasVisibleWorkspaceAttachedItems}
                      onAddToChat={handleAddToChat}
                      onFilePreview={handleFilePreview}
                    />
                    {showSessionFiles && workspaceSlug && (
                      <FileDropZone
                        workspaceSlug={workspaceSlug}
                        sessionId={sessionId}
                        target="session"
                        onFilesUploaded={handleFilesUploaded}
                        onFilesAttached={handleSessionFilesAttached}
                        onAttachFolder={handleAttachSessionFolder}
                        onFoldersDropped={handleSessionFoldersDropped}
                      />
                    )}
                    {showProjectFiles && !isProjectRootUnavailable && workspaceSlug && (
                      <FileDropZone
                        workspaceSlug={workspaceSlug}
                        target="workspace"
                        onFilesUploaded={handleFilesUploaded}
                        onFilesAttached={handleWorkspaceFilesAttached}
                        onAttachFolder={handleAttachWorkspaceFolder}
                        onFoldersDropped={handleWorkspaceFoldersDropped}
                      />
                    )}
                  </div>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">等待会话初始化...</div>
              )}
            </div>
          ) : null}
        </div>
    </div>
  )
}

// ===== 附加文件容器 =====

interface AttachedFilesSectionProps {
  title?: string
  scope?: 'project' | 'session'
  showSessionBadge?: boolean
  attachedFiles: string[]
  onDetach: (filePath: string) => void
  onAddToChat?: (entry: FileEntry) => void
  onFilePreview?: (filePath: string) => void
  allowedPaths?: string[]
  sessionId: string
}

function AttachedFilesSection({ title, scope = 'project', showSessionBadge = true, attachedFiles, onDetach, onAddToChat, onFilePreview, allowedPaths, sessionId }: AttachedFilesSectionProps): React.ReactElement {
  return (
    <div className="pt-1 pb-0 flex-shrink-0">
      {title && <div className="text-[11px] font-medium text-muted-foreground mb-1 px-3">{title}</div>}
      {attachedFiles.map((filePath) => {
        const name = getPathBasename(filePath)
        const entry: FileEntry = { name, path: filePath, isDirectory: false }
        return (
          <div
            key={filePath}
            className="flex items-center gap-1 py-1 pl-2 pr-2 text-sm cursor-pointer hover:bg-accent/50 group mx-2 rounded-lg"
            onClick={() => onFilePreview?.(filePath)}
            draggable
            onDragStart={(e) => {
              e.stopPropagation()
              setFilePanelDragData(e.dataTransfer, [{
                path: filePath,
                name,
                isDirectory: false,
                scope,
              }])
            }}
          >
            <span className="w-3.5 flex-shrink-0" />
            <FileTypeIcon name={name} isDirectory={false} />
            <span className="text-xs truncate flex-1" title={filePath}>{name}</span>
            {showSessionBadge && scope === 'session' && (
              <span className="flex-shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">会话文件</span>
            )}
            <div
              className="flex-shrink-0 mr-1"
              draggable={false}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="h-6 w-6 rounded flex items-center justify-center hover:bg-accent/70 text-muted-foreground hover:text-foreground invisible group-hover:visible focus-visible:visible data-[state=open]:visible"
                    title="更多操作"
                    aria-label="更多操作"
                  >
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-40 z-[9999] min-w-0 p-0.5">
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => dispatchInsertFileMention([{
                      path: filePath,
                      name,
                      isDirectory: false,
                      scope,
                    }])}
                  >
                    <MessageSquarePlus />
                    引用到 Agent
                  </DropdownMenuItem>
                  {onAddToChat && (
                    <DropdownMenuItem
                      className="text-xs py-1 [&>svg]:size-3.5"
                      onSelect={() => onAddToChat(entry)}
                    >
                      <MessageSquarePlus />
                      添加到聊天
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => window.electronAPI.showAttachedInFolder(filePath, { sessionId, candidateBasePaths: allowedPaths }).catch(console.error)}
                  >
                    <FolderSearch />
                    在文件夹中显示
                  </DropdownMenuItem>
                  {onFilePreview && (
                    <DropdownMenuItem
                      className="text-xs py-1 [&>svg]:size-3.5"
                      onSelect={() => onFilePreview(filePath)}
                    >
                      <ExternalLink />
                      打开文件
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="text-xs py-1 text-destructive focus:text-destructive [&>svg]:size-3.5"
                    onSelect={() => onDetach(filePath)}
                  >
                    <X />
                    移除附加
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ===== 附加目录容器（管理选中状态） =====

interface AttachedDirsSectionProps {
  title?: string
  scope?: 'project' | 'session'
  showSessionBadge?: boolean
  attachedDirs: string[]
  onDetach: (dirPath: string) => void
  /** 文件版本号，用于自动刷新已展开的目录 */
  refreshVersion: number
  onAddToChat?: (entry: FileEntry) => void
  onFilePreview?: (filePath: string) => void
  /** 所有允许访问的路径（传给 IPC 做路径校验） */
  allowedPaths?: string[]
  sessionId: string
}

/** 附加目录区域：统一管理所有子项的选中状态 */
function AttachedDirsSection({ title, scope = 'project', showSessionBadge = true, attachedDirs, onDetach, refreshVersion, onAddToChat, onFilePreview, allowedPaths, sessionId }: AttachedDirsSectionProps): React.ReactElement {
  const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(new Set())

  // ===== 接入搜索点击触发的 reveal：附加目录文件搜到后，需要展开/选中目标 =====
  const autoReveal = useAtomValue(fileBrowserAutoRevealAtom)
  // 找到 reveal target 命中的那个附加目录根。如果用户附加了嵌套目录（如同时附加 /a 和 /a/b），
  // 取"最深匹配"——只让真正包含该文件的最近一棵树展开，避免外层 /a 树被无谓打开。
  const revealRoot = React.useMemo(() => {
    if (!autoReveal) return null
    let best: string | null = null
    for (const dir of attachedDirs) {
      if (!isPathUnderRoot(dir, autoReveal.path)) continue
      if (!best || dir.length > best.length) best = dir
    }
    return best
  }, [autoReveal, attachedDirs])
  const revealTarget = revealRoot ? autoReveal!.path : null
  const revealTs = revealRoot ? autoReveal!.ts : 0
  const revealSelect = revealRoot ? !!autoReveal!.select : false

  // 命中本区域 + select=true：把目标加入选中态（与 FileBrowser 行为对齐）
  const consumedSelectTsRef = React.useRef(0)
  React.useEffect(() => {
    if (!revealSelect || !revealTarget || revealTs === 0) return
    if (revealTs <= consumedSelectTsRef.current) return
    consumedSelectTsRef.current = revealTs
    setSelectedPaths(new Set([revealTarget]))
  }, [revealTs, revealSelect, revealTarget])

  const handleSelect = React.useCallback((path: string, ctrlKey: boolean) => {
    setSelectedPaths((prev) => {
      if (ctrlKey) {
        // Ctrl+点击：切换选中
        const next = new Set(prev)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        return next
      }
      // 普通点击：单选
      return new Set([path])
    })
  }, [])

  return (
    <div className="file-tree-guide-scope pt-1 pb-0 flex-shrink-0">
      {title && <div className="text-[11px] font-medium text-muted-foreground mb-1 px-3">{title}</div>}
      {attachedDirs.map((dir) => {
        const isRevealRoot = dir === revealRoot
        return (
          <AttachedDirTree
            key={dir}
            dirPath={dir}
            onDetach={() => onDetach(dir)}
            selectedPaths={selectedPaths}
            onSelect={handleSelect}
            refreshVersion={refreshVersion}
            onAddToChat={onAddToChat}
            onFilePreview={onFilePreview}
            allowedPaths={allowedPaths}
            sessionId={sessionId}
            scope={scope}
            showSessionBadge={showSessionBadge}
            revealTarget={isRevealRoot ? revealTarget : null}
            revealTs={isRevealRoot ? revealTs : 0}
          />
        )
      })}
    </div>
  )
}

// ===== 附加目录树组件 =====

interface AttachedDirTreeProps {
  dirPath: string
  onDetach: () => void
  selectedPaths: Set<string>
  onSelect: (path: string, ctrlKey: boolean) => void
  refreshVersion: number
  onAddToChat?: (entry: FileEntry) => void
  onFilePreview?: (filePath: string) => void
  allowedPaths?: string[]
  sessionId: string
  scope: 'project' | 'session'
  showSessionBadge: boolean
  /** 自动定位目标（仅当落在此 dirPath 之下时由父级传入，否则为 null） */
  revealTarget?: string | null
  /** 自动定位脉冲时间戳，变化时重新触发 */
  revealTs?: number
}

function AttachedDirTree({ dirPath, onDetach, selectedPaths, onSelect, refreshVersion, onAddToChat, onFilePreview, allowedPaths, sessionId, scope, showSessionBadge, revealTarget = null, revealTs = 0 }: AttachedDirTreeProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const [children, setChildren] = React.useState<FileEntry[]>([])
  const [loaded, setLoaded] = React.useState(false)

  const dirName = dirPath.split(/[\\/]/).filter(Boolean).pop() || dirPath

  // 计算从 dirPath 到 revealTarget 之间的祖先目录集合（用于子项决定是否自动展开）
  const revealAncestors = React.useMemo(
    () => revealTarget ? computeRevealAncestors(dirPath, revealTarget) : new Set<string>(),
    [dirPath, revealTarget],
  )

  // 当 refreshVersion 变化时，已展开的目录自动重新加载
  React.useEffect(() => {
    if (expanded && loaded) {
      window.electronAPI.listAttachedDirectory(dirPath, { sessionId, candidateBasePaths: allowedPaths })
        .then((items) => setChildren(items))
        .catch((err) => console.error('[AttachedDirTree] 刷新失败:', err))
    }
  }, [refreshVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  // ===== 自动定位：reveal target 命中时自动加载子项 + 展开 =====
  React.useEffect(() => {
    if (revealTs === 0 || !revealTarget) return
    let cancelled = false
    const run = async (): Promise<void> => {
      if (!loaded) {
        try {
          const items = await window.electronAPI.listAttachedDirectory(dirPath, { sessionId, candidateBasePaths: allowedPaths })
          if (!cancelled) {
            setChildren(items)
            setLoaded(true)
          }
        } catch (err) {
          console.error('[AttachedDirTree] reveal 加载失败:', err)
          return
        }
      }
      if (!cancelled) setExpanded(true)
    }
    void run()
    return () => { cancelled = true }
  }, [revealTs]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleExpand = async (): Promise<void> => {
    if (!expanded && !loaded) {
      try {
        const items = await window.electronAPI.listAttachedDirectory(dirPath, { sessionId, candidateBasePaths: allowedPaths })
        setChildren(items)
        setLoaded(true)
      } catch (err) {
        console.error('[AttachedDirTree] 加载失败:', err)
      }
    }
    setExpanded(!expanded)
  }

  // depth=0 的根行，与 FileBrowser 保持一致的布局：铺满、无外边距、可 sticky
  const { paddingLeft, guideLeft } = computeTreeRowLayout(0)
  const isSticky = expanded

  return (
    <div className="relative">
      <div
        data-sticky-row={isSticky ? 'true' : undefined}
        className={cn(
          'file-tree-row relative flex h-8 items-center gap-1 pr-2 text-sm cursor-pointer group',
          isSticky && cn(STICKY_ROW_BASE_CLASS, 'top-0 z-10'),
        )}
        style={{ paddingLeft }}
        onClick={toggleExpand}
        draggable
        onDragStart={(e) => {
          e.stopPropagation()
          setFilePanelDragData(e.dataTransfer, [{
            path: dirPath,
            name: dirName,
            isDirectory: true,
            scope,
          }])
        }}
      >
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-y-0 left-2 right-2 z-0 rounded-[17px] transition-colors',
            // sticky 行 hover 用不透明色，避免下方滚动内容透出；普通行保持半透明柔和感
            isSticky ? 'group-hover:bg-accent' : 'group-hover:bg-accent/50',
          )}
        />
        <ChevronRight
          className={cn(
            'relative z-10 size-3.5 text-muted-foreground flex-shrink-0 transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
        <FileTypeIcon name={dirName} isDirectory isOpen={expanded} className="relative z-10" />
        <span className="relative z-10 text-xs truncate flex-1" title={dirPath}>
          {dirName}
        </span>
        {showSessionBadge && scope === 'session' && (
          <span className="relative z-10 flex-shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">会话文件</span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative z-10 h-6 w-6 mr-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
          onClick={(e) => { e.stopPropagation(); onDetach() }}
        >
          <X className="size-3" />
        </Button>
      </div>
      {expanded && (
        <div className="relative">
          <span
            aria-hidden="true"
            className="file-tree-guide pointer-events-none absolute bottom-1 top-0 w-px bg-border/70"
            style={{ left: guideLeft }}
          />
          {children.length === 0 && loaded && (
            <div
              className="text-[11px] text-muted-foreground/50 py-1"
              style={{ paddingLeft: paddingLeft + 24 }}
            >
              空文件夹
            </div>
          )}
          {children.map((child) => (
            <AttachedDirItem key={child.path} entry={child} depth={1} selectedPaths={selectedPaths} onSelect={onSelect} refreshVersion={refreshVersion} onAddToChat={onAddToChat} onFilePreview={onFilePreview} allowedPaths={allowedPaths} sessionId={sessionId} scope={scope} revealTarget={revealTarget} revealTs={revealTs} revealAncestors={revealAncestors} />
          ))}
        </div>
      )}
    </div>
  )
}

interface AttachedDirItemProps {
  entry: FileEntry
  depth: number
  selectedPaths: Set<string>
  onSelect: (path: string, ctrlKey: boolean) => void
  refreshVersion: number
  onAddToChat?: (entry: FileEntry) => void
  onFilePreview?: (filePath: string) => void
  allowedPaths?: string[]
  sessionId: string
  scope: 'project' | 'session'
  /** 自动定位目标路径，命中则滚动到中心 */
  revealTarget?: string | null
  /** 自动定位脉冲时间戳，变化时重新触发 */
  revealTs?: number
  /** 祖先目录集合，命中则自动展开 */
  revealAncestors?: Set<string>
}

function AttachedDirItem({ entry, depth, selectedPaths, onSelect, refreshVersion, onAddToChat, onFilePreview, allowedPaths, sessionId, scope, revealTarget = null, revealTs = 0, revealAncestors }: AttachedDirItemProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const [children, setChildren] = React.useState<FileEntry[]>([])
  const [loaded, setLoaded] = React.useState(false)
  // 重命名状态
  const [isRenaming, setIsRenaming] = React.useState(false)
  const [renameValue, setRenameValue] = React.useState(entry.name)
  const renameInputRef = React.useRef<HTMLInputElement>(null)
  // 当前显示的名称和路径（重命名后更新）
  const [currentName, setCurrentName] = React.useState(entry.name)
  const [currentPath, setCurrentPath] = React.useState(entry.path)
  const rowRef = React.useRef<HTMLDivElement>(null)

  const isSelected = selectedPaths.has(currentPath)

  // 当 refreshVersion 变化时，已展开的文件夹自动重新加载子项
  React.useEffect(() => {
    if (expanded && loaded && entry.isDirectory) {
      window.electronAPI.listAttachedDirectory(currentPath, { sessionId, candidateBasePaths: allowedPaths })
        .then((items) => setChildren(items))
        .catch((err) => console.error('[AttachedDirItem] 刷新子目录失败:', err))
    }
  }, [refreshVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  // ===== 自动定位：祖先目录自动展开 + 目标行滚动到中心 =====
  React.useEffect(() => {
    if (revealTs === 0 || !revealTarget) return

    const isAncestor = !!revealAncestors && revealAncestors.has(currentPath)
    const isTarget = currentPath === revealTarget

    const scrollToTarget = (): void => {
      requestAnimationFrame(() => {
        rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    }

    // 自身需要展开：祖先目录 OR 目标本身就是目录
    const willExpand = entry.isDirectory && (isAncestor || isTarget) && !expanded
    if (willExpand) {
      let cancelled = false
      const run = async (): Promise<void> => {
        if (!loaded) {
          try {
            const items = await window.electronAPI.listAttachedDirectory(currentPath, { sessionId, candidateBasePaths: allowedPaths })
            if (!cancelled) {
              setChildren(items)
              setLoaded(true)
            }
          } catch (err) {
            console.error('[AttachedDirItem] reveal 加载子目录失败:', err)
            return
          }
        }
        if (cancelled) return
        setExpanded(true)
        // 目标自身就是这个目录时，等展开成功后再滚动，避免子项渲染改变行高使
        // smooth scroll 偏离；加载失败路径自然跳过滚动。
        if (isTarget) scrollToTarget()
      }
      void run()
      return () => { cancelled = true }
    }

    // 目标行：滚动到可视区中心（不打 flash，直接靠选中态高亮）
    if (isTarget) scrollToTarget()
  }, [revealTs]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleDir = async (): Promise<void> => {
    if (!entry.isDirectory) return
    if (!expanded && !loaded) {
      try {
        const items = await window.electronAPI.listAttachedDirectory(currentPath, { sessionId, candidateBasePaths: allowedPaths })
        setChildren(items)
        setLoaded(true)
      } catch (err) {
        console.error('[AttachedDirItem] 加载子目录失败:', err)
      }
    }
    setExpanded(!expanded)
  }

  const handleClick = (e: React.MouseEvent): void => {
    const isMulti = e.ctrlKey || e.metaKey
    onSelect(currentPath, isMulti)
    if (isMulti) return
    if (entry.isDirectory) {
      void toggleDir()
    } else {
      onFilePreview?.(currentPath)
    }
  }

  // 开始重命名
  const startRename = (): void => {
    setRenameValue(currentName)
    setIsRenaming(true)
    // 延迟聚焦，等待 DOM 渲染
    setTimeout(() => renameInputRef.current?.select(), 50)
  }

  // 确认重命名
  const confirmRename = async (): Promise<void> => {
    const newName = renameValue.trim()
    if (!newName || newName === currentName) {
      setIsRenaming(false)
      return
    }
    try {
      await window.electronAPI.renameAttachedFile(currentPath, newName, { sessionId, candidateBasePaths: allowedPaths })
      // 更新本地显示
      const parentDir = getPathDirname(currentPath)
      const newPath = joinPath(parentDir, newName)
      // 更新选中状态中的路径
      onSelect(newPath, false)
      setCurrentName(newName)
      setCurrentPath(newPath)
    } catch (err) {
      console.error('[AttachedDirItem] 重命名失败:', err)
    }
    setIsRenaming(false)
  }

  // 取消重命名
  const cancelRename = (): void => {
    setIsRenaming(false)
    setRenameValue(currentName)
  }

  // 移动到文件夹
  const handleMove = async (): Promise<void> => {
    try {
      const result = await window.electronAPI.openFolderDialog()
      if (!result) return
      await window.electronAPI.moveAttachedFile(currentPath, result.path, { sessionId, candidateBasePaths: allowedPaths })
      // 移动后更新路径
      const newPath = joinPath(result.path, currentName)
      setCurrentPath(newPath)
    } catch (err) {
      console.error('[AttachedDirItem] 移动失败:', err)
    }
  }

  const { paddingLeft, guideLeft, stickyTop, stickyZIndex } = computeTreeRowLayout(depth)
  const isSticky = entry.isDirectory && expanded && canBeSticky(depth)

  return (
    <>
      <div
        ref={rowRef}
        data-sticky-row={isSticky ? 'true' : undefined}
        className={cn(
          'file-tree-row relative flex h-8 items-center gap-1 pr-2 text-sm cursor-pointer group',
          isSticky && STICKY_ROW_BASE_CLASS,
        )}
        style={{
          paddingLeft,
          top: isSticky ? stickyTop : undefined,
          zIndex: isSticky ? stickyZIndex : undefined,
        }}
        onClick={handleClick}
        draggable={!isRenaming}
        onDragStart={(e) => {
          e.stopPropagation()
          setFilePanelDragData(e.dataTransfer, [{
            path: currentPath,
            name: currentName,
            isDirectory: entry.isDirectory,
            scope,
          }])
        }}
      >
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-y-0 left-2 right-2 z-0 rounded-[17px] transition-colors',
            // sticky 行 hover 用不透明色，避免下方滚动内容透出；普通行保持半透明柔和感
            isSelected
              ? 'bg-accent'
              : isSticky
                ? 'group-hover:bg-accent'
                : 'group-hover:bg-accent/50',
          )}
        />
        {/* sticky 行祖先链竖线，逻辑见 tree-row-layout.tsx 的 AncestorGuides。
            选中态下 bg-accent 不透明背景会盖住原 border 色，组件内部已切到 accent-foreground。 */}
        {isSticky && <AncestorGuides depth={depth} isSelected={isSelected} />}
        {entry.isDirectory ? (
          <ChevronRight
            className={cn(
              'relative z-10 size-3.5 text-muted-foreground flex-shrink-0 transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
        ) : (
          <span className="relative z-10 w-3.5 flex-shrink-0" />
        )}
        <FileTypeIcon name={currentName} isDirectory={entry.isDirectory} isOpen={expanded} className="relative z-10" />

        {/* 名称：正常显示 / 重命名输入框 */}
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="relative z-10 text-xs flex-1 min-w-0 bg-background border border-primary rounded px-1 py-0.5 outline-none"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmRename()
              if (e.key === 'Escape') cancelRename()
              e.stopPropagation()
            }}
            onBlur={confirmRename}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="relative z-10 truncate text-xs flex-1">{currentName}</span>
        )}

        {/* 右侧操作按钮占位 */}
        <div
          className="relative z-10 flex-shrink-0 mr-1"
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* 悬浮/选中状态：三点菜单 */}
          {!isRenaming && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'h-6 w-6 rounded flex items-center justify-center hover:bg-accent/70 text-muted-foreground hover:text-foreground',
                  !isSelected && 'invisible group-hover:visible focus-visible:visible data-[state=open]:visible',
                )}
                title="更多操作"
                aria-label="更多操作"
                onClick={() => {
                  if (!isSelected) onSelect(currentPath, false)
                }}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40 z-[9999] min-w-0 p-0.5">
                <DropdownMenuItem
                  className="text-xs py-1 [&>svg]:size-3.5"
                  onSelect={() => dispatchInsertFileMention([{
                    path: currentPath,
                    name: currentName,
                    isDirectory: entry.isDirectory,
                    scope,
                  }])}
                >
                  <MessageSquarePlus />
                  引用到 Agent
                </DropdownMenuItem>
                {onAddToChat && !entry.isDirectory && (
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => onAddToChat({ ...entry, path: currentPath, name: currentName })}
                  >
                    <MessageSquarePlus />
                    添加到聊天
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  className="text-xs py-1 [&>svg]:size-3.5"
                  onSelect={() => window.electronAPI.showAttachedInFolder(currentPath, { sessionId, candidateBasePaths: allowedPaths }).catch(console.error)}
                >
                  <FolderSearch />
                  在文件夹中显示
                </DropdownMenuItem>
                {!entry.isDirectory && onFilePreview && (
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => onFilePreview(currentPath)}
                  >
                    <ExternalLink />
                    打开文件
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  className="text-xs py-1 [&>svg]:size-3.5"
                  onSelect={startRename}
                >
                  <Pencil />
                  重命名
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-xs py-1 [&>svg]:size-3.5"
                  onSelect={handleMove}
                >
                  <FolderInput />
                  移动到...
                </DropdownMenuItem>
              </DropdownMenuContent>
          </DropdownMenu>
          )}
        </div>
      </div>
      {expanded && (
        <div className="relative">
          <span
            aria-hidden="true"
            className="file-tree-guide pointer-events-none absolute bottom-1 top-0 w-px bg-border/70"
            style={{ left: guideLeft }}
          />
          {children.length === 0 && loaded && (
            <div
              className="text-[11px] text-muted-foreground/50 py-1"
              style={{ paddingLeft: paddingLeft + 24 }}
            >
              空文件夹
            </div>
          )}
          {children.map((child) => (
            <AttachedDirItem key={child.path} entry={child} depth={depth + 1} selectedPaths={selectedPaths} onSelect={onSelect} refreshVersion={refreshVersion} onAddToChat={onAddToChat} onFilePreview={onFilePreview} allowedPaths={allowedPaths} sessionId={sessionId} scope={scope} revealTarget={revealTarget} revealTs={revealTs} revealAncestors={revealAncestors} />
          ))}
        </div>
      )}
    </>
  )
}

// ===== 右侧问答「查看现有问答」列表行 =====

interface SideChatConversationRowProps {
  conversation: ConversationMeta
  /** 当前相对时间基准（父级 60 秒刷新），保证停留时标签不过期 */
  relativeTimeNow: number
  onSelect: (conversationId: string) => void
  /** 删除问答对话（hover 显示删除按钮） */
  onDelete: (conversationId: string) => void
}

/** 右侧问答列表行 — 样式对齐左侧边栏对话列表项（memo 惯例同 ConversationItem） */
const SideChatConversationRow = React.memo(function SideChatConversationRow({ conversation, relativeTimeNow, onSelect, onDelete }: SideChatConversationRowProps): React.ReactElement {
  return (
    <div className="group relative w-full flex items-center gap-1.5 rounded-md py-1 pl-2.5 pr-1.5 transition-colors duration-100 hover:bg-foreground/[0.03]">
      <button
        type="button"
        onClick={() => onSelect(conversation.id)}
        className="min-w-0 flex-1 text-left"
        title={`打开问答：${conversation.title}`}
      >
        <span className="block truncate text-[13px] leading-[18px] text-foreground/80 group-hover:text-foreground">
          {conversation.title}
        </span>
      </button>
      <span className="flex-shrink-0 text-[11px] leading-[18px] tabular-nums text-foreground/35">
        {formatRelativeUpdatedAt(conversation.updatedAt, relativeTimeNow)}
      </span>
      <button
        type="button"
        onClick={() => onDelete(conversation.id)}
        className="flex-shrink-0 rounded p-0.5 text-foreground/35 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
        title="删除问答对话"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  )
})
