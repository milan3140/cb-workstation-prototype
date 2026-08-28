import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info as InfoIcon } from 'lucide-react'

/* hover ⓘ 說明(設計備註:公式/說明拿掉,變 hover info icon 放在對應變數旁)
   用 portal + fixed 定位,不被表格 overflow-x 容器裁掉;
   視窗邊界偵測:優先放上方,上方空間不夠翻到下方;水平夾在視窗內(不超出頁面)。
   tip 可為字串(純說明)或 { text, formula }(第一段說明、第二段計算式) */
export default function Info({ tip }) {
  const [anchor, setAnchor] = useState(null)     // 觸發 icon 的位置
  const [style, setStyle] = useState(null)       // 算好的 tooltip 位置 + 上/下方向
  const boxRef = useRef(null)
  const spanRef = useRef(null)
  const text = typeof tip === 'string' ? tip : tip?.text
  const formula = (tip && typeof tip === 'object') ? tip.formula : null

  const open = el => { const r = el.getBoundingClientRect(); setAnchor({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom }) }
  const close = () => { setAnchor(null); setStyle(null) }

  // 開啟時,點/觸外面關閉(手機沒 hover,靠點擊開合)
  useEffect(() => {
    if (!anchor) return undefined
    const onDoc = e => {
      if (spanRef.current?.contains(e.target) || boxRef.current?.contains(e.target)) return
      close()
    }
    document.addEventListener('pointerdown', onDoc)
    return () => document.removeEventListener('pointerdown', onDoc)
  }, [anchor])

  useLayoutEffect(() => {
    if (!anchor || !boxRef.current) { setStyle(null); return }
    const box = boxRef.current.getBoundingClientRect()
    const gap = 8
    const above = anchor.top - gap - box.height >= 8            // 上方放得下?
    const top = above ? anchor.top - gap - box.height : anchor.bottom + gap
    let left = anchor.x - box.width / 2                         // 水平置中
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8))   // 夾在視窗內
    setStyle({ left, top, place: above ? 'above' : 'below' })
  }, [anchor, text, formula])

  return (
    <span className="info" ref={spanRef}
      onClick={e => { e.stopPropagation(); anchor ? close() : open(e.currentTarget) }}>
      <InfoIcon size={15} aria-label="說明" />
      {anchor && createPortal(
        <div ref={boxRef} role="tooltip"
          className={`tipbox${style ? ` tip-${style.place}` : ''}`}
          style={style ? { left: style.left, top: style.top } : { left: -9999, top: -9999, opacity: 0 }}>
          <p className="tip-desc">{text}</p>
          {formula && <p className="tip-formula"><span className="tip-flabel">計算式</span>{formula}</p>}
        </div>,
        document.body,
      )}
    </span>
  )
}
