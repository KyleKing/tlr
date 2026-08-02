import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import rough from 'roughjs/bundled/rough.esm.js'

export interface StrokeOptions {
  stroke: string
  strokeWidth: number
  roughness: number
  bowing: number
  seed: number
  fill?: string
  fillStyle?: string
  fillWeight?: number
  hachureAngle?: number
  hachureGap?: number
  disableMultiStroke?: boolean
}

const HOUSE_STYLE = {
  roughness: 1.15,
  bowing: 1,
  strokeWidth: 1.9,
} as const

/**
 * Turns a string into a stable roughjs seed so a shape keeps the same wobble
 * across re-renders. Re-randomising on every paint reads as a glitch, not a sketch.
 */
export function seedFrom(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h % 2147483647) || 1
}

export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  if (radius === 0) return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`
  return [
    `M ${x + radius} ${y}`,
    `L ${x + w - radius} ${y}`,
    `Q ${x + w} ${y} ${x + w} ${y + radius}`,
    `L ${x + w} ${y + h - radius}`,
    `Q ${x + w} ${y + h} ${x + w - radius} ${y + h}`,
    `L ${x + radius} ${y + h}`,
    `Q ${x} ${y + h} ${x} ${y + h - radius}`,
    `L ${x} ${y + radius}`,
    `Q ${x} ${y} ${x + radius} ${y}`,
    'Z',
  ].join(' ')
}

/**
 * Reads a CSS custom property off the host element so shapes follow the active
 * palette, including the high-contrast override, without prop plumbing.
 */
function resolveVar(el: Element, value: string): string {
  const match = /^var\((--[^),]+)(?:,\s*(.*))?\)$/.exec(value.trim())
  if (!match) return value
  const resolved = getComputedStyle(el).getPropertyValue(match[1]).trim()
  return resolved || (match[2] ?? 'currentColor')
}

export function strokeOptions(el: Element, overrides: Partial<StrokeOptions> & { seed: number }): StrokeOptions {
  const scale = Number.parseFloat(getComputedStyle(el).getPropertyValue('--rd-stroke-scale')) || 1
  return {
    ...HOUSE_STYLE,
    ...overrides,
    stroke: resolveVar(el, overrides.stroke ?? 'var(--rd-ink)'),
    fill: overrides.fill ? resolveVar(el, overrides.fill) : undefined,
    strokeWidth: (overrides.strokeWidth ?? HOUSE_STYLE.strokeWidth) * scale,
  }
}

type DrawFn = (rc: ReturnType<typeof rough.svg>, w: number, h: number, host: Element) => (SVGGElement | null)[]

/**
 * Keeps an inline SVG sized to its host box and redraws the sketch when the box
 * changes. Callers own the drawing; this owns measurement and cleanup.
 */
export function useSketch(host: Ref<HTMLElement | undefined>, svg: Ref<SVGSVGElement | undefined>, draw: DrawFn, deps: Ref<unknown>[] = []) {
  const width = ref(0)
  const height = ref(0)
  let observer: ResizeObserver | undefined

  function paint() {
    const svgEl = svg.value
    const hostEl = host.value
    if (!svgEl || !hostEl || width.value < 2 || height.value < 2) return
    svgEl.replaceChildren()
    // roughjs sizes its generator off these attributes, not off CSS layout.
    svgEl.setAttribute('width', String(width.value))
    svgEl.setAttribute('height', String(height.value))
    svgEl.setAttribute('viewBox', `0 0 ${width.value} ${height.value}`)
    const rc = rough.svg(svgEl)
    for (const node of draw(rc, width.value, height.value, hostEl)) {
      if (node) svgEl.appendChild(node)
    }
  }

  onMounted(() => {
    const hostEl = host.value
    if (!hostEl) return
    observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (!box) return
      width.value = Math.round(box.width)
      height.value = Math.round(box.height)
    })
    observer.observe(hostEl)
  })

  onUnmounted(() => observer?.disconnect())

  watch([width, height, ...deps], paint, { flush: 'post' })

  return { width, height, paint }
}
