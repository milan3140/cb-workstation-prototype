import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, MoreHorizontal, Pencil, Plus, Trash2, X } from 'lucide-react'

/* 關注清單切換列。
   ├ 左：可橫向捲動的 tabs 軌道;active 底下有金色滑動指示器(切換帶微動畫、不閃)。
   └ 右：固定不捲動的動作區——「⋯」(操作目前清單:改名/複製/刪除)、「＋」(新增)。
   選單以 portal 掛到 body、fixed 定位:逃出軌道的 overflow 裁切(舊版被縫住的根因),永遠在最上層。 */
export default function WatchlistBar({ lists, activeId, max, onPick, onAddBlank, onCopy, onRename, onRemove }) {
  const [menu, setMenu] = useState(null)        // 'list' | 'add' | null
  const [anchor, setAnchor] = useState(null)    // 觸發鈕的螢幕座標(portal 定位用)
  const [confirm, setConfirm] = useState(null)  // 待確認刪除的清單(彈 modal)
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState('')
  const trackRef = useRef(null)
  const tabRefs = useRef({})
  const [ind, setInd] = useState({ x: 0, w: 0, ready: false })

  const atMax = lists.length >= max
  const active = lists.find(l => l.id === activeId)

  // 滑動指示器移到 active tab;並在軌道內水平捲入可視範圍(只動軌道、不捲整頁)
  useLayoutEffect(() => {
    const el = tabRefs.current[activeId]
    const track = trackRef.current
    if (!el || !track) return
    setInd({ x: el.offsetLeft, w: el.offsetWidth, ready: true })
    const l = el.offsetLeft, r = l + el.offsetWidth
    if (l < track.scrollLeft) track.scrollTo({ left: l - 12, behavior: 'smooth' })
    else if (r > track.scrollLeft + track.clientWidth) track.scrollTo({ left: r - track.clientWidth + 12, behavior: 'smooth' })
  }, [activeId, lists])

  const openMenu = (kind, e) => {
    const r = e.currentTarget.getBoundingClientRect()
    setAnchor({ left: r.left, right: r.right, bottom: r.bottom })
    setMenu(kind)
  }
  // 選單:捲動/縮放/Esc → 關(fixed 定位不跟著跑,故直接關最穩)。modal:Esc → 關。
  useEffect(() => {
    if (!menu && !confirm) return
    const onKey = e => { if (e.key === 'Escape') { setMenu(null); setConfirm(null) } }
    document.addEventListener('keydown', onKey)
    if (!menu) return () => document.removeEventListener('keydown', onKey)
    const closeMenu = () => setMenu(null)
    window.addEventListener('resize', closeMenu)
    window.addEventListener('scroll', closeMenu, true)
    return () => {
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu, confirm])

  const startRename = l => { setEditing(l.id); setDraft(l.name); setMenu(null) }
  const commitRename = () => { if (editing) onRename(editing, draft.trim()); setEditing(null) }

  function renderMenu() {
    if (!menu || !anchor) return null
    const W = 176
    const left = Math.max(8, Math.min(anchor.right - W, window.innerWidth - W - 8))
    const top = anchor.bottom + 8
    const items = menu === 'add' ? (
      <>
        <button role="menuitem" onClick={() => { onAddBlank(); setMenu(null) }}><Plus size={15} />空白清單</button>
        <button role="menuitem" onClick={() => { onCopy(); setMenu(null) }}><Copy size={15} />複製目前清單</button>
      </>
    ) : active ? (
      <>
        <button role="menuitem" onClick={() => startRename(active)}><Pencil size={15} />重新命名</button>
        <button role="menuitem" disabled={atMax} onClick={() => { onCopy(); setMenu(null) }}><Copy size={15} />複製這份</button>
        <button role="menuitem" className="danger"
          onClick={() => { setConfirm(active); setMenu(null) }}><Trash2 size={15} />刪除</button>
      </>
    ) : null
    return createPortal(
      <>
        <div className="wl-backdrop" onPointerDown={() => setMenu(null)} />
        <div className="wl-menu" role="menu" style={{ top, left, width: W }}
          onPointerDown={e => e.stopPropagation()}>
          {items}
        </div>
      </>, document.body,
    )
  }

  function renderConfirm() {
    if (!confirm) return null
    return createPortal(
      <div className="wl-modal-scrim" onPointerDown={() => setConfirm(null)}>
        <div className="wl-modal" role="alertdialog" aria-modal="true" aria-labelledby="wl-cf-t"
          onPointerDown={e => e.stopPropagation()}>
          <div className="wl-modal-ic"><Trash2 size={20} /></div>
          <h3 id="wl-cf-t" className="wl-modal-t">刪除「{confirm.name}」?</h3>
          <p className="wl-modal-d">這份清單的 {confirm.codes.length} 檔關注會一併移除,此動作無法復原。</p>
          <div className="wl-modal-act">
            <button className="wl-btn ghost" onClick={() => setConfirm(null)}>取消</button>
            <button className="wl-btn danger" autoFocus
              onClick={() => { onRemove(confirm.id); setConfirm(null) }}>刪除</button>
          </div>
        </div>
      </div>, document.body,
    )
  }

  return (
    <div className="wlbar">
      <div className="wl-track" ref={trackRef} role="tablist" aria-label="我的關注清單">
        <span className="wl-ind" aria-hidden="true"
          style={{ transform: `translateX(${ind.x}px)`, width: ind.w, opacity: ind.ready ? 1 : 0 }} />
        {lists.map(l => {
          if (editing === l.id) {
            return (
              <span key={l.id} className="wl-edit">
                <input autoFocus value={draft} maxLength={40} aria-label="清單名稱"
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditing(null) }} />
                <button className="wl-ic ok" onClick={commitRename} aria-label="確定"><Check size={15} /></button>
                <button className="wl-ic" onClick={() => setEditing(null)} aria-label="取消"><X size={15} /></button>
              </span>
            )
          }
          const on = l.id === activeId
          return (
            <button key={l.id} ref={el => { tabRefs.current[l.id] = el }}
              className={`wl-tab${on ? ' on' : ''}`} role="tab" aria-selected={on}
              onClick={e => (on ? openMenu('list', e) : onPick(l.id))}>
              <span className="wl-nm">{l.name}</span>
              <span className="wl-ct">{l.codes.length}</span>
            </button>
          )
        })}
      </div>

      <div className="wl-actions">
        {active && (
          <button className="wl-more" aria-label="目前清單選項" title="重新命名 / 複製 / 刪除"
            onClick={e => openMenu('list', e)}><MoreHorizontal size={17} /></button>
        )}
        <button className="wl-add" disabled={atMax} aria-label={atMax ? '已達清單上限' : '新增清單'}
          title={atMax ? `最多 ${max} 份` : '新增清單'} onClick={e => openMenu('add', e)}>
          <Plus size={16} />
        </button>
      </div>

      {renderMenu()}
      {renderConfirm()}
    </div>
  )
}
