import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

// 自訂下拉膠囊:棄用原生 select(在深色主題很醜),改成主題化選單 + 開合微動畫。
// 選單用 position:fixed 依觸發鈕座標定位,避免被工具列的 overflow-x:auto 裁切。
// bare=true:不畫外層膠囊(只出 button + 選單),供多個下拉共用同一顆膠囊時組合用。
export default function PillSelect({ label, value, options, onChange, ariaLabel, title, plain, bare }) {
  const rootRef = useRef(null)
  const btnRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const current = options.find(o => o.value === value)

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 6, left: r.left, minWidth: r.width })
  }, [])

  const toggle = () => { if (!open) place(); setOpen(o => !o) }
  const pick = v => { onChange(v); setOpen(false) }

  useEffect(() => {
    if (!open) return
    const onDoc = e => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false) }
    const onKey = e => { if (e.key === 'Escape') setOpen(false) }
    const onShift = () => setOpen(false)          // 捲動/縮放時直接收合,免得選單漂移
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onShift)
    window.addEventListener('scroll', onShift, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onShift)
      window.removeEventListener('scroll', onShift, true)
    }
  }, [open])

  if (bare) {
    return (
      <span className={`kpill-slot${open ? ' is-open' : ''}`} ref={rootRef}>
        <button type="button" ref={btnRef} className="kpill-btn" onClick={toggle}
          aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} title={title}>
          <span className="kpill-val">{current?.label ?? '—'}</span>
          <ChevronDown size={15} className="kpill-caret" aria-hidden="true" />
        </button>
        {open && pos && (
          <ul className="kpill-menu" role="listbox" aria-label={ariaLabel}
            style={{ top: `${pos.top}px`, left: `${pos.left}px`, minWidth: `${pos.minWidth}px` }}>
            {options.map(o => (
              <li key={o.value} role="option" aria-selected={o.value === value}
                className={`kpill-opt${o.value === value ? ' active' : ''}${o.disabled ? ' disabled' : ''}`}
                onClick={() => !o.disabled && pick(o.value)}>
                <span>{o.label}</span>
                {o.value === value && <Check size={15} aria-hidden="true" />}
              </li>
            ))}
          </ul>
        )}
      </span>
    )
  }

  return (
    <div className={`kpill${plain ? ' kpill-plain' : ''}${open ? ' is-open' : ''}`} ref={rootRef}>
      {label && <span className="kpill-lbl">{label}</span>}
      <button type="button" ref={btnRef} className="kpill-btn" onClick={toggle}
        aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} title={title}>
        <span className="kpill-val">{current?.label ?? '—'}</span>
        <ChevronDown size={15} className="kpill-caret" aria-hidden="true" />
      </button>
      {open && pos && (
        <ul className="kpill-menu" role="listbox" aria-label={ariaLabel}
          style={{ top: `${pos.top}px`, left: `${pos.left}px`, minWidth: `${pos.minWidth}px` }}>
          {options.map(o => (
            <li key={o.value} role="option" aria-selected={o.value === value}
              className={`kpill-opt${o.value === value ? ' active' : ''}${o.disabled ? ' disabled' : ''}`}
              onClick={() => !o.disabled && pick(o.value)}>
              <span>{o.label}</span>
              {o.value === value && <Check size={15} aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
