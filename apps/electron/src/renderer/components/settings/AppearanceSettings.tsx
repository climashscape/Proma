/**
 * AppearanceSettings - 外观设置页
 *
 * 特殊风格选择 + 主题模式切换（浅色/深色/跟随系统/特殊风格）。
 * 通过 Jotai atom 管理状态，持久化到 ~/.proma/settings.json。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsSegmentedControl,
} from './primitives'
import {
  themeModeAtom,
  themeStyleAtom,
  interfaceVariantAtom,
  systemIsDarkAtom,
  solarLocationAtom,
  updateThemeMode,
  updateThemeStyle,
  updateInterfaceVariant,
  updateSolarLocation,
  applyThemeToDOM,
  applyInterfaceVariantToDOM,
} from '@/atoms/theme'
import { searchCities, type City } from '@/lib/cities'
import { getSunriseSunset, isDaytime, nextTransition } from '@/lib/solar'
import {
  markdownFontSizeAtom,
  updateMarkdownFontSize,
} from '@/atoms/markdown-font-size'
import { previewModePreferenceAtom, type PreviewModePreference } from '@/atoms/preview-atoms'
import { cn } from '@/lib/utils'
import { detectIsWindows } from '@/lib/platform'
import type { InterfaceVariant, ThemeMode, ThemeStyle, MarkdownFontSize } from '../../../types'

// ===== Logo 资源导入（用于图标选择器） =====
import promaBlackLogo from '@/assets/bots/proma-logos/proma-black.png'
import promaWhiteLogo from '@/assets/bots/proma-logos/proma-white.png'
import promaBlueLogo from '@/assets/bots/proma-logos/proma-blue.png'
import promaPurpleLogo from '@/assets/bots/proma-logos/proma-purple.png'
import promaGradientLogo from '@/assets/bots/proma-logos/proma-gradient.png'
import promaCoralLogo from '@/assets/bots/proma-logos/proma-coral.png'
import promaVeriPeriLogo from '@/assets/bots/proma-logos/proma-veri-peri.png'
import promaVivaMagentaLogo from '@/assets/bots/proma-logos/proma-viva-magenta.png'
import promaMochaMousseLogo from '@/assets/bots/proma-logos/proma-mocha-mousse.png'
import promaEmeraldLogo from '@/assets/bots/proma-logos/proma-emerald.png'
import proma8bitLogo from '@/assets/bots/proma-logos/proma-8bit.png'
import promaCyberpunkLogo from '@/assets/bots/proma-logos/proma-cyberpunk.png'
import promaFuturisticLogo from '@/assets/bots/proma-logos/proma-futuristic.png'

// ===== 主题预览图片导入 =====
import themeCloudDancer from '@/assets/theme-previews/theme-cloud-dancer.webp'
import themeOceanLight from '@/assets/theme-previews/theme-ocean-light.webp'
import themeForestMorning from '@/assets/theme-previews/theme-forest-morning.webp'
import themeOceanDark from '@/assets/theme-previews/theme-ocean-dark.webp'
import themeForestNight from '@/assets/theme-previews/theme-forest-night.webp'
import themeMorandiNight from '@/assets/theme-previews/theme-morandi-night.webp'
import themeTerminalDark from '@/assets/theme-previews/theme-terminal-dark.png'

/** 主题选项 */
const THEME_OPTIONS = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
  { value: 'solar', label: '日出日落' },
  { value: 'special', label: '特殊风格' },
]

/** 界面风格选项 */
const INTERFACE_VARIANT_OPTIONS: { value: InterfaceVariant; label: string }[] = [
  { value: 'classic', label: '经典' },
  { value: 'modern', label: '现代' },
]

/** Markdown 字号选项 */
const MARKDOWN_FONT_SIZE_OPTIONS = [
  { value: 'small', label: '小' },
  { value: 'medium', label: '中' },
  { value: 'large', label: '大' },
]

/** 预览默认展开方式 */
const PREVIEW_MODE_OPTIONS: { value: PreviewModePreference; label: string }[] = [
  { value: 'tab', label: '标签页' },
  { value: 'split', label: '侧边分屏' },
]

/** 特殊风格 ID（排除 default） */
type SpecialStyleId = Exclude<ThemeStyle, 'default'>

/** 特殊风格定义 */
interface SpecialStyle {
  id: SpecialStyleId
  name: string
  variant: 'light' | 'dark'
  /** 主题预览图 */
  image: string
  /** 图片裁剪位置（默认居中） */
  objectPosition?: string
  /** 图片缩放比例（默认 1） */
  imageScale?: number
  /** Tooltip 提示 */
  tooltip?: string
}

const SPECIAL_STYLES: readonly SpecialStyle[] = [
  {
    id: 'slate-light',
    name: '云朵舞者',
    variant: 'light',
    image: themeCloudDancer,
    imageScale: 1.3,
  },
  {
    id: 'ocean-light',
    name: '晴空碧海',
    variant: 'light',
    image: themeOceanLight,
  },
  {
    id: 'forest-light',
    name: '森息晨光',
    variant: 'light',
    image: themeForestMorning,
    imageScale: 1.45,
  },
  {
    id: 'ocean-dark',
    name: '远山暮霭',
    variant: 'dark',
    image: themeOceanDark,
  },
  {
    id: 'forest-dark',
    name: '森息夜语',
    variant: 'dark',
    image: themeForestNight,
  },
  {
    id: 'slate-dark',
    name: '莫兰迪夜',
    variant: 'dark',
    image: themeMorandiNight,
    imageScale: 1.15,
    objectPosition: '44% 58%',
  },
  {
    id: 'terminal-dark',
    name: '旧屏微光',
    variant: 'dark',
    image: themeTerminalDark,
    tooltip: '该主题包含轻微闪烁动画',
  },
]

/** 图标变体定义 */
interface IconVariant {
  id: string
  name: string
  src: string
  previewBg: string
}

const ICON_VARIANTS: readonly IconVariant[] = [
  { id: 'default', name: '默认', src: '', previewBg: 'bg-neutral-900' },
  { id: 'black', name: '经典黑', src: promaBlackLogo, previewBg: 'bg-neutral-900' },
  { id: 'white', name: '纯白版', src: promaWhiteLogo, previewBg: 'bg-white' },
  { id: 'blue', name: '品牌蓝', src: promaBlueLogo, previewBg: 'bg-blue-900' },
  { id: 'purple', name: '紫色版', src: promaPurpleLogo, previewBg: 'bg-purple-900' },
  { id: 'gradient', name: '渐变版', src: promaGradientLogo, previewBg: 'bg-gradient-to-br from-blue-600 to-purple-600' },
  { id: 'coral', name: '珊瑚橘', src: promaCoralLogo, previewBg: 'bg-[#FF6F61]' },
  { id: 'veri-peri', name: '长春花蓝', src: promaVeriPeriLogo, previewBg: 'bg-[#6667AB]' },
  { id: 'viva-magenta', name: '非凡洋红', src: promaVivaMagentaLogo, previewBg: 'bg-[#BB2649]' },
  { id: 'mocha-mousse', name: '摩卡慕斯', src: promaMochaMousseLogo, previewBg: 'bg-[#A47764]' },
  { id: 'emerald', name: '翡翠绿', src: promaEmeraldLogo, previewBg: 'bg-[#009473]' },
  { id: '8bit', name: '8bit 像素', src: proma8bitLogo, previewBg: 'bg-[#1a1a2e]' },
  { id: 'cyberpunk', name: '赛博朋克', src: promaCyberpunkLogo, previewBg: 'bg-[#0d0221]' },
  { id: 'futuristic', name: '未来质感', src: promaFuturisticLogo, previewBg: 'bg-[#4a4a4a]' },
] as const

/** 根据平台返回缩放快捷键提示 */
const isMac = navigator.userAgent.includes('Mac')
const ZOOM_HINT = isMac
  ? '使用 ⌘+ 放大、⌘- 缩小、⌘0 恢复默认大小'
  : '使用 Ctrl++ 放大、Ctrl+- 缩小、Ctrl+0 恢复默认大小'

export function AppearanceSettings(): React.ReactElement {
  const [themeMode, setThemeMode] = useAtom(themeModeAtom)
  const [themeStyle, setThemeStyle] = useAtom(themeStyleAtom)
  const [interfaceVariant, setInterfaceVariant] = useAtom(interfaceVariantAtom)
  const systemIsDark = useAtomValue(systemIsDarkAtom)
  const [solarLocation, setSolarLocation] = useAtom(solarLocationAtom)
  const [markdownFontSize, setMarkdownFontSize] = useAtom(markdownFontSizeAtom)
  const [previewModePref, setPreviewModePref] = useAtom(previewModePreferenceAtom)

  /** 切换主题模式 */
  const handleThemeChange = React.useCallback((value: string) => {
    const mode = value as ThemeMode
    setThemeMode(mode)
    updateThemeMode(mode)
    // 切换回普通模式时，重置特殊风格
    if (mode !== 'special') {
      setThemeStyle('default')
      updateThemeStyle('default')
    }
    if (mode === 'solar') {
      // solar 模式根据当前位置计算深浅，未配置位置时退回深色
      const isDark = solarLocation ? !isDaytime(solarLocation.lat, solarLocation.lng) : true
      applyThemeToDOM('solar', 'default', isDark)
    } else {
      applyThemeToDOM(mode, 'default', systemIsDark)
    }
  }, [setThemeMode, setThemeStyle, systemIsDark, solarLocation])

  /** 选择日出日落位置 */
  const handleSolarLocationSelect = React.useCallback((city: City) => {
    const loc = { lat: city.lat, lng: city.lng, name: city.name }
    setSolarLocation(loc)
    updateSolarLocation(loc)
    // 选定位置后立即应用一次主题
    applyThemeToDOM('solar', 'default', !isDaytime(city.lat, city.lng))
  }, [setSolarLocation])

  /** 选择特殊风格 */
  const handleStyleSelect = React.useCallback((style: ThemeStyle) => {
    // 同时切换到特殊风格模式
    setThemeMode('special')
    setThemeStyle(style)
    updateThemeMode('special')
    updateThemeStyle(style)
    applyThemeToDOM('special', style, systemIsDark)
  }, [setThemeMode, setThemeStyle, systemIsDark])

  /** 切换界面风格 */
  const handleInterfaceVariantChange = React.useCallback((value: string) => {
    const variant = value as InterfaceVariant
    setInterfaceVariant(variant)
    updateInterfaceVariant(variant)
    applyInterfaceVariantToDOM(variant)
  }, [setInterfaceVariant])

  /** 切换 Markdown 字号 */
  const handleMarkdownFontSizeChange = React.useCallback((value: string) => {
    const size = value as MarkdownFontSize
    setMarkdownFontSize(size)
    updateMarkdownFontSize(size)
  }, [setMarkdownFontSize])

  return (
    <div className="space-y-6">
      <SettingsSection
        title="外观设置"
        description="自定义应用的视觉风格"
      >
        <SettingsCard>
          {/* 主题模式 - 最上面 */}
          <SettingsSegmentedControl
            label="主题模式"
            description="选择应用的配色方案"
            value={themeMode}
            onValueChange={handleThemeChange}
            options={THEME_OPTIONS}
          />

          {/* 日出日落模式：城市选择 + 下次切换预览 */}
          {themeMode === 'solar' && (
            <SolarLocationPicker
              location={solarLocation}
              onSelect={handleSolarLocationSelect}
              onClear={() => {
                setSolarLocation(null)
                updateSolarLocation(null)
              }}
            />
          )}

          <SettingsSegmentedControl
            label="界面风格"
            description="经典风保留旧版视觉；现代风使用更小圆角、更清晰分割线达成更统一干净的质感"
            value={interfaceVariant}
            onValueChange={handleInterfaceVariantChange}
            options={INTERFACE_VARIANT_OPTIONS}
          />

          {/* 特殊风格 - 标签在上，卡片在下 */}
          <div className="px-4 py-3 space-y-2">
            <div className="text-sm font-medium text-foreground">特殊风格</div>
            <div className="grid grid-cols-7 gap-3">
              {SPECIAL_STYLES.map((style) => (
                <StyleCard
                  key={style.id}
                  style={style}
                  isSelected={themeMode === 'special' && themeStyle === style.id}
                  onSelect={() => handleStyleSelect(style.id)}
                />
              ))}
            </div>
          </div>

          <SettingsRow
            label="界面缩放"
            description={ZOOM_HINT}
          />

          <SettingsSegmentedControl
            label="Markdown 字号"
            description="调整 AI 回复与 Markdown 编辑器的正文字号"
            value={markdownFontSize}
            onValueChange={handleMarkdownFontSizeChange}
            options={MARKDOWN_FONT_SIZE_OPTIONS}
          />

          <SettingsSegmentedControl
            label="Agent 预览展开方式"
            description="点击文件、工具结果「预览」按钮时的默认展开位置；拖拽预览 Tab 出标签栏可即时切换为侧边分屏"
            value={previewModePref}
            onValueChange={(v) => setPreviewModePref(v as PreviewModePreference)}
            options={PREVIEW_MODE_OPTIONS}
          />
        </SettingsCard>
      </SettingsSection>

      <AppIconPicker />
    </div>
  )
}

/** 应用图标选择器 */
function AppIconPicker(): React.ReactElement {
  const [activeIcon, setActiveIcon] = React.useState<string>('default')
  const [isLoading, setIsLoading] = React.useState(false)

  // 初始化时读取当前设置
  React.useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      setActiveIcon(settings.appIconVariant ?? 'default')
    })
  }, [])

  const isWindows = React.useMemo(() => detectIsWindows(), [])

  const handleIconSelect = React.useCallback(async (variantId: string) => {
    if (isWindows) {
      toast.error('Windows 系统暂不支持更换应用图标')
      return
    }
    if (variantId === activeIcon || isLoading) return
    setIsLoading(true)
    try {
      const success = await window.electronAPI.setAppIcon(variantId)
      if (success) {
        setActiveIcon(variantId)
        toast.success('应用图标已更换')
      } else {
        toast.error('图标切换失败')
      }
    } catch {
      toast.error('图标切换失败')
    } finally {
      setIsLoading(false)
    }
  }, [activeIcon, isLoading, isWindows])

  return (
    <SettingsSection
      title="应用图标"
      description="自定义 Dock 栏中的应用图标样式"
    >
      <SettingsCard divided={false}>
        <div className="px-4 py-3">
          <div className="grid grid-cols-7 gap-3">
            {ICON_VARIANTS.map((variant) => (
              <IconCard
                key={variant.id}
                variant={variant}
                isSelected={activeIcon === variant.id}
                onSelect={() => handleIconSelect(variant.id)}
              />
            ))}
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

/** 图标选项卡片 */
function IconCard({
  variant,
  isSelected,
  onSelect,
}: {
  variant: IconVariant
  isSelected: boolean
  onSelect: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative flex flex-col items-center gap-1.5 rounded-lg p-2 transition-all',
        isSelected
          ? 'ring-2 ring-primary bg-primary/5'
          : 'hover:bg-muted/50'
      )}
    >
      <div
        className={cn(
          'w-12 h-12 rounded-xl overflow-hidden border border-border/50 flex items-center justify-center',
          variant.previewBg,
        )}
      >
        {variant.id === 'default' ? (
          // 默认图标用 CSS 模拟 Proma logo 形状
          <div className="flex items-end gap-[2px] -rotate-12">
            {[1, 0.85, 0.7, 0.55, 0.4, 0.25].map((opacity, i) => (
              <div
                key={i}
                className="rounded-[1px]"
                style={{
                  width: i === 0 ? 4 : 3,
                  height: i === 0 ? 14 : 14 - i * 1.5,
                  backgroundColor: `rgba(255,255,255,${opacity})`,
                }}
              />
            ))}
          </div>
        ) : (
          <img
            src={variant.src}
            alt={variant.name}
            className="w-full h-full object-contain"
            draggable={false}
          />
        )}
      </div>
      <span className="text-[10px] font-medium text-muted-foreground leading-tight text-center">
        {variant.name}
      </span>
      {isSelected && (
        <div className="absolute -top-0.5 -right-0.5 size-4 rounded-full bg-primary flex items-center justify-center">
          <Check className="size-2.5 text-primary-foreground" />
        </div>
      )}
    </button>
  )
}

/** 特殊风格卡片 - 竖长条图片预览 + 名字放在卡片下方 */
function StyleCard({
  style,
  isSelected,
  onSelect,
}: {
  style: SpecialStyle
  isSelected: boolean
  onSelect: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={style.tooltip}
      className="group flex flex-col items-center gap-2 focus-visible:outline-none"
    >
      {/* 图片卡片本体 */}
      <div
        className={cn(
          'relative rounded-lg overflow-hidden w-[99px] h-[183px] transition-all duration-150',
          isSelected
            ? 'ring-2 ring-primary shadow-lg shadow-primary/20'
            : 'ring-1 ring-border/50 group-hover:ring-border group-focus-visible:ring-2 group-focus-visible:ring-primary group-focus-visible:ring-offset-1'
        )}
      >
        <div
          className="w-full h-full"
          style={style.imageScale ? { transform: `scale(${style.imageScale})` } : undefined}
        >
          <img
            src={style.image}
            alt={style.name}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
            style={style.objectPosition ? { objectPosition: style.objectPosition } : undefined}
            draggable={false}
          />
        </div>
        {isSelected && (
          <div className="absolute top-1 right-1 size-4 rounded-full bg-primary flex items-center justify-center z-10">
            <Check className="size-2.5 text-primary-foreground" />
          </div>
        )}
      </div>
      {/* 名字放在卡片下方，吃 token，自动跟主题切色 */}
      <span
        className={cn(
          'text-xs font-medium transition-colors',
          isSelected ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'
        )}
      >
        {style.name}
      </span>
    </button>
  )
}

/** 日出日落模式的城市选择器 + 下次切换预览 */
function SolarLocationPicker({
  location,
  onSelect,
  onClear,
}: {
  location: { lat: number; lng: number; name: string } | null
  onSelect: (city: City) => void
  onClear: () => void
}): React.ReactElement {
  const [query, setQuery] = React.useState('')
  const [showResults, setShowResults] = React.useState(false)
  const results = React.useMemo(() => (showResults ? searchCities(query, 30) : []), [query, showResults])

  // 下次切换预览（位置已配置时）
  const transition = React.useMemo(() => {
    if (!location) return null
    return nextTransition(location.lat, location.lng)
  }, [location])

  // 当前日出日落时刻（位置已配置时）
  const sunTimes = React.useMemo(() => {
    if (!location) return null
    return getSunriseSunset(new Date(), location.lat, location.lng)
  }, [location])

  const formatTime = (d: Date | null): string => {
    if (!d) return '—（极昼/极夜）'
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  }

  return (
    <div className="px-4 py-3 space-y-3">
      <div className="space-y-1">
        <div className="text-sm font-medium text-foreground">日出日落位置</div>
        <div className="text-xs text-muted-foreground">
          应用将根据此位置的日出日落时刻自动切换深浅色，不依赖系统设置
        </div>
      </div>

      {/* 当前位置 + 下次切换预览 */}
      {location && (
        <div className="rounded-lg bg-muted/40 px-3 py-2 space-y-1 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">当前位置</span>
            <span className="font-medium text-foreground">{location.name}</span>
          </div>
          {sunTimes && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">今日日出</span>
                <span className="text-foreground">{formatTime(sunTimes.sunrise)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">今日日落</span>
                <span className="text-foreground">{formatTime(sunTimes.sunset)}</span>
              </div>
            </>
          )}
          {transition && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">下次切换</span>
              <span className="text-foreground">
                {formatTime(transition.at)} → {transition.to === 'dark' ? '深色' : '浅色'}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          >
            清除位置
          </button>
        </div>
      )}

      {/* 搜索框 */}
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setShowResults(true)
          }}
          onFocus={() => setShowResults(true)}
          onBlur={() => setTimeout(() => setShowResults(false), 150)}
          placeholder="搜索城市（如 北京、东京、纽约）"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        {showResults && results.length > 0 && (
          <div className="absolute z-10 mt-1 w-full max-h-60 overflow-auto rounded-md border border-border bg-background shadow-lg">
            {results.map((c) => (
              <button
                key={`${c.country}-${c.name}`}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelect(c)
                  setQuery('')
                  setShowResults(false)
                }}
                className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-muted/50 text-left"
              >
                <span className="text-foreground">{c.name}</span>
                <span className="text-xs text-muted-foreground">{c.country}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!location && (
        <div className="text-xs text-muted-foreground">
          请先选择一个城市以启用日出日落切换
        </div>
      )}
    </div>
  )
}
