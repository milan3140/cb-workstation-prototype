import React, { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { MAX_TEXT_LENGTH } from '../../kline/schema.js'

export default function TextAnnotationDialog({ open, initialValue = '', mode = 'create', onCancel, onConfirm }) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef(null)

  useEffect(() => {
    if (!open) return
    setValue(initialValue)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open, initialValue])

  if (!open) return null
  const submit = event => {
    event.preventDefault()
    const next = value.trim()
    if (next) onConfirm(next)
  }

  return (
    <div className="text-dialog-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onCancel()
    }}>
      <form className="text-dialog" role="dialog" aria-modal="true" aria-labelledby="text-dialog-title" onSubmit={submit}>
        <button type="button" className="text-dialog-close" aria-label="關閉" onClick={onCancel}><X size={18} /></button>
        <h3 id="text-dialog-title">{mode === 'edit' ? '編輯文字標註' : '新增文字標註'}</h3>
        <label>
          標註內容
          <textarea ref={inputRef} value={value} maxLength={MAX_TEXT_LENGTH} rows={3}
            onChange={event => setValue(event.target.value)} onKeyDown={event => {
              if (event.key === 'Escape') onCancel()
            }} />
        </label>
        <div className="text-dialog-meta"><span>不支援 HTML</span><span>{value.length}/{MAX_TEXT_LENGTH}</span></div>
        <div className="text-dialog-actions">
          <button type="button" onClick={onCancel}>取消</button>
          <button type="submit" className="primary" disabled={!value.trim()}>{mode === 'edit' ? '儲存' : '開始放置'}</button>
        </div>
      </form>
    </div>
  )
}
