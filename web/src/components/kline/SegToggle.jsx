import React, { useLayoutEffect, useRef, useState } from 'react'

// 左右滑動的分段切換(現股/轉債):金塊在兩節間滑移,切換時先「拉伸」跨越兩節再收束到目標=液化效果。
export default function SegToggle({ options, value, onChange, ariaLabel }) {
  const wrapRef = useRef(null)
  const btnRefs = useRef({})
  const settledRef = useRef(null)                 // 上一個定位好的 {left,width}
  const [thumb, setThumb] = useState({ left: 0, width: 0, ready: false })

  useLayoutEffect(() => {
    const el = btnRefs.current[value]
    const wrap = wrapRef.current
    if (!el || !wrap) return
    const measure = () => {
      const w = wrap.getBoundingClientRect()
      const b = el.getBoundingClientRect()
      return { left: b.left - w.left, width: b.width }
    }
    const target = measure()
    const prev = settledRef.current
    settledRef.current = target
    if (prev && Math.abs(prev.left - target.left) > 0.5) {
      // 液化:先鋪成 prev∪target 的聯集(拉長),再收束到 target
      const left = Math.min(prev.left, target.left)
      const right = Math.max(prev.left + prev.width, target.left + target.width)
      setThumb({ left, width: right - left, ready: true })
      const t = setTimeout(() => setThumb({ ...target, ready: true }), 165)
      return () => clearTimeout(t)
    }
    setThumb({ ...target, ready: true })
    const onResize = () => { const m = measure(); settledRef.current = m; setThumb({ ...m, ready: true }) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [value, options.length])

  return (
    <div className="kseg" role="tablist" aria-label={ariaLabel} ref={wrapRef}>
      <span className="kseg-thumb" aria-hidden="true"
        style={{ left: `${thumb.left}px`, width: `${thumb.width}px`, opacity: thumb.ready ? 1 : 0 }} />
      {options.map(o => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} title={o.title}
          ref={el => { btnRefs.current[o.value] = el }}
          className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
