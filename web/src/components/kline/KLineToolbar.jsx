import React from 'react'
import {
  Brush, Download, Eraser, Minus, MousePointer2, MoveVertical,
  Redo2, RefreshCw, Square, Trash2, TrendingUp, Type, Undo2,
} from 'lucide-react'
import Info from '../Info.jsx'

const OP_HINT = '滾輪查看明細;Ctrl／Cmd＋滾輪縮放。選工具進畫線模式,再按一次或 Esc 回看盤。畫線依股票與週期分開儲存。'

/* 工具分組:依「使用頻率 + 功能」擺放(id 與 DrawingOverlay.js 的 tool 命名一致)
   1 導覽(預設) | 2 畫圖形(核心高頻) | 3 標註+編輯 —— destructive(清除全部)另外拉到最右分開 */
const GROUPS = [
  [{ id: 'select', label: '選取', Icon: MousePointer2 }],
  [
    { id: 'line', label: '趨勢線', Icon: TrendingUp },
    { id: 'hline', label: '水平線', Icon: Minus },
    { id: 'vline', label: '垂直線', Icon: MoveVertical },
    { id: 'rect', label: '矩形', Icon: Square },
    { id: 'brush', label: '筆刷', Icon: Brush },
  ],
  [
    { id: 'text', label: '文字', Icon: Type },
    { id: 'eraser', label: '橡皮擦', Icon: Eraser },
  ],
]

function ToolButton({ active, disabled, label, onClick, compact = false, danger = false, children }) {
  return (
    <button type="button"
      className={`draw-tool${active ? ' active' : ''}${compact ? ' compact' : ''}${danger ? ' danger' : ''}`}
      disabled={disabled} aria-label={label} title={label} aria-pressed={active} onClick={onClick}>
      {children}
      {!compact && <span>{label}</span>}
    </button>
  )
}

export default function KLineToolbar({
  activeTool, hasSelection, color, lineWidth, canUndo, canRedo, hasDrawings, syncing,
  onTool, onColor, onLineWidth, onUndo, onRedo, onDelete, onClear, onExport, onSync,
}) {
  const showStyle = Boolean(activeTool) || hasSelection
  // 清除全部=破壞性且不可逆→二次確認,避免誤觸
  const confirmClear = () => {
    if (hasDrawings && window.confirm('確定清除這檔（此週期）全部畫線?')) onClear()
  }

  return (
    <div className="draw-toolbar" role="toolbar" aria-label="K 線畫圖工具">
      {GROUPS.map((group, gi) => (
        <React.Fragment key={gi}>
          {gi > 0 && <span className="draw-div" aria-hidden />}
          {group.map(({ id, label, Icon }) => (
            <ToolButton key={id} active={activeTool === id} label={label} onClick={() => onTool(id)}>
              <Icon size={17} />
            </ToolButton>
          ))}
        </React.Fragment>
      ))}

      {showStyle && (
        <>
          <span className="draw-div" aria-hidden />
          <div className="draw-tools-style" aria-label="目前圖形樣式">
            <label className="draw-color" title="畫線顏色">
              <span>顏色</span>
              <input type="color" value={color} onChange={event => onColor(event.target.value)} />
            </label>
            <label className="draw-width">
              <span>線寬</span>
              <select value={lineWidth} onChange={event => onLineWidth(Number(event.target.value))}>
                {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value}px</option>)}
              </select>
            </label>
          </div>
        </>
      )}
      {hasSelection && (
        <ToolButton compact label="刪除選取" onClick={onDelete}><Trash2 size={17} /></ToolButton>
      )}

      {/* 歷史/匯出群組推到右側 */}
      <span className="draw-div draw-div-push" aria-hidden />
      <ToolButton compact label="復原" disabled={!canUndo} onClick={onUndo}><Undo2 size={17} /></ToolButton>
      <ToolButton compact label="重做" disabled={!canRedo} onClick={onRedo}><Redo2 size={17} /></ToolButton>
      <ToolButton compact label="匯出圖片" onClick={onExport}><Download size={17} /></ToolButton>
      {/* 刷新畫線:從雲端重新拉這檔(此週期)畫線,同步其他裝置的變更;沿用載入的資料保全規則 */}
      <ToolButton compact label="刷新畫線（同步其他裝置）" disabled={syncing} onClick={onSync}>
        <RefreshCw size={17} className={syncing ? 'spin' : undefined} />
      </ToolButton>
      <span className="draw-tool-info" title="操作說明"><Info tip={OP_HINT} /></span>

      {/* 清除全部畫線:再分隔、紅色 danger + 二次確認(避免誤觸) */}
      <span className="draw-div" aria-hidden />
      <ToolButton danger label="清除全部" disabled={!hasDrawings} onClick={confirmClear}>
        <Trash2 size={17} />
      </ToolButton>
    </div>
  )
}
