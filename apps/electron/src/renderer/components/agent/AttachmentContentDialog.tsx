import React from 'react'
import { FileText, Folder } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface AttachmentContentDialogProps {
  /** 是否显示弹窗（受控） */
  open: boolean
  /** 打开状态变化回调（取消/关闭时传 false） */
  onOpenChange: (open: boolean) => void
  /** 用户选择附加类型后回调 */
  onSelect: (type: 'file' | 'folder') => void
}

/**
 * Composer 附加内容类型选择弹窗。
 * 替代原先主进程的系统原生 MessageBox，保持 Proma 自身 UI 风格。
 */
export function AttachmentContentDialog({
  open,
  onOpenChange,
  onSelect,
}: AttachmentContentDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>附加文件或文件夹</DialogTitle>
          <DialogDescription>请选择要附加的内容类型</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {/* 文件为默认操作：焦点（autoFocus）、Enter 默认触发、视觉主按钮三者统一 */}
          <Button type="button" variant="default" autoFocus onClick={() => onSelect('file')}>
            <FileText className="size-4" />
            文件
          </Button>
          <Button type="button" variant="outline" onClick={() => onSelect('folder')}>
            <Folder className="size-4" />
            文件夹
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
