import { registerOverlay } from 'klinecharts'
import { DRAWING_GROUP, normalizeDrawing } from './schema.js'

let registered = false

export function registerSignalOverlays() {
  if (registered) return
  registerOverlay({
    name: 'signalRectangle',
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    mode: 'weak_magnet',
    modeSensitivity: 8,
    createPointFigures: ({ coordinates }) => {
      if (coordinates.length < 2) return []
      const x = Math.min(coordinates[0].x, coordinates[1].x)
      const y = Math.min(coordinates[0].y, coordinates[1].y)
      return {
        type: 'rect',
        attrs: {
          x,
          y,
          width: Math.abs(coordinates[1].x - coordinates[0].x),
          height: Math.abs(coordinates[1].y - coordinates[0].y),
        },
      }
    },
  })
  registerOverlay({
    name: 'signalText',
    totalStep: 2,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    mode: 'weak_magnet',
    modeSensitivity: 8,
    createPointFigures: ({ overlay, coordinates }) => {
      if (!coordinates.length) return []
      return {
        type: 'text',
        attrs: {
          x: coordinates[0].x,
          y: coordinates[0].y - 10,
          text: String(overlay.extendData || ''),
          align: 'center',
          baseline: 'bottom',
        },
      }
    },
  })
  registered = true
}

export function overlayStyles(color, lineWidth) {
  return {
    line: { color, size: lineWidth, style: 'solid', dashedValue: [5, 4] },
    rect: {
      style: 'stroke_fill',
      color: `${color}1f`,
      borderColor: color,
      borderSize: lineWidth,
      borderStyle: 'solid',
      borderDashedValue: [5, 4],
    },
    text: { color, size: 14, family: 'Inter, system-ui, sans-serif', weight: '600' },
    polygon: { style: 'fill', color, borderColor: color, borderSize: 1, borderStyle: 'solid', borderDashedValue: [] },
  }
}

export function serializeOverlays(overlays) {
  return overlays.map(overlay => normalizeDrawing({
    id: overlay.id,
    name: overlay.name,
    points: overlay.points,
    extendData: overlay.extendData,
    style: {
      color: overlay.styles?.line?.color || overlay.styles?.rect?.borderColor || overlay.styles?.text?.color,
      lineWidth: overlay.styles?.line?.size || overlay.styles?.rect?.borderSize,
    },
    lock: overlay.lock,
  })).filter(Boolean)
}

export function drawingToOverlay(drawing, callbacks = {}) {
  return {
    id: drawing.id,
    name: drawing.name,
    groupId: DRAWING_GROUP,
    points: drawing.points,
    extendData: drawing.extendData,
    lock: drawing.lock,
    mode: 'weak_magnet',
    modeSensitivity: 8,
    styles: overlayStyles(drawing.style.color, drawing.style.lineWidth),
    ...callbacks,
  }
}
