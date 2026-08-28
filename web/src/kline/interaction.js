export function wheelIntent({ focusMode = false, activeTool = null, ctrlKey = false, metaKey = false } = {}) {
  if (activeTool) return 'drawing'
  if (focusMode) return 'chart'
  return ctrlKey || metaKey ? 'cooperative-zoom' : 'page-scroll'
}

export function cooperativeZoomFactor(deltaY) {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1
  const magnitude = Math.min(0.28, Math.max(0.08, Math.abs(deltaY) / 500))
  return deltaY < 0 ? 1 + magnitude : 1 - magnitude
}

export function renewDrawingDraft(draft) {
  if (!draft?.tool) return null
  return {
    tool: draft.tool,
    text: draft.text ?? null,
    anchor: null,
    current: null,
    points: [],
    pressed: false,
    finishing: false,
  }
}
