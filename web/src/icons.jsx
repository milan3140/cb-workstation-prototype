/* 策略 icon 統一入口(硬性:禁 emoji/字符 glyph,一律 inline SVG,Lucide 風)。
   概念對應(來自 UIUX checklist):
     總覽=grid/radar、發動=trending-up、熱度=心跳脈波 activity、
     賣回=盾/底線、折價=雙向收斂箭頭、CBAS=zap/槓桿。
   以策略 id 對映,logic.js 只存 id,JSX 端一律用 <StratIcon id=.. />。 */
import React from 'react'
import { Activity, ChevronsRightLeft, LayoutGrid, Shield, Sparkles, Star, TrendingUp, Zap } from 'lucide-react'

const MAP = {
  // 新 IA 底部導覽
  pick: Sparkles,      // 精選訊號
  all: LayoutGrid,     // 全市場
  watch: Star,         // 我的關注
  // 舊策略 id(仍可能被引用)
  fire: TrendingUp,
  heatcb: Activity,
  floor: Shield,
  discount: ChevronsRightLeft,
  cbas: Zap,
}

export function StratIcon({ id, size = 14, strokeWidth = 2 }) {
  const Ico = MAP[id]
  if (!Ico) return null
  return <Ico size={size} strokeWidth={strokeWidth} aria-hidden />
}
