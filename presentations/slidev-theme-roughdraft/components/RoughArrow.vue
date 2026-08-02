<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { highContrast } from './contrast'
import { seedFrom, strokeOptions, useSketch } from './rough'

const props = withDefaults(defineProps<{
  dir?: 'right' | 'left' | 'down' | 'up' | 'down-right' | 'down-left'
  pen?: 'ink' | 'blue' | 'red' | 'violet' | 'quiet'
  weight?: number
  curve?: number
  seed?: string
}>(), {
  dir: 'right',
  pen: 'quiet',
  weight: 2,
  curve: 0.22,
  seed: 'arrow',
})

const host = ref<HTMLElement>()
const svg = ref<SVGSVGElement>()
const seed = computed(() => seedFrom(`${props.seed}:${props.dir}`))
const isPortrait = computed(() => props.dir === 'up' || props.dir === 'down')

const ENDS: Record<string, [number, number, number, number]> = {
  right: [0.04, 0.5, 0.94, 0.5],
  left: [0.96, 0.5, 0.06, 0.5],
  down: [0.5, 0.04, 0.5, 0.94],
  up: [0.5, 0.96, 0.5, 0.06],
  'down-right': [0.06, 0.08, 0.92, 0.9],
  'down-left': [0.94, 0.08, 0.08, 0.9],
}

useSketch(host, svg, (rc, w, h, el) => {
  // Arrows carry meaning rather than decorate, so they draw in the text-safe variant
  // and stay readable across a room. RoughRule keeps the lighter stroke variant.
  const opts = strokeOptions(el, {
    seed: seed.value,
    stroke: `var(--rd-pen-${props.pen}-ink)`,
    strokeWidth: props.weight,
  })
  const [sx, sy, ex, ey] = ENDS[props.dir] ?? ENDS.right
  const x1 = sx * w
  const y1 = sy * h
  const x2 = ex * w
  const y2 = ey * h

  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const cx = (x1 + x2) / 2 - dy * props.curve
  const cy = (y1 + y2) / 2 + dx * props.curve

  const angle = Math.atan2(y2 - cy, x2 - cx)
  const head = Math.max(9, Math.min(16, len * 0.24))
  const spread = 0.42

  return [
    rc.path(`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`, opts),
    rc.line(x2, y2, x2 - head * Math.cos(angle - spread), y2 - head * Math.sin(angle - spread), opts),
    rc.line(x2, y2, x2 - head * Math.cos(angle + spread), y2 - head * Math.sin(angle + spread), opts),
  ]
}, [toRef(highContrast)])
</script>

<template>
  <span ref="host" class="rd-arrow" :class="{ 'rd-arrow--portrait': isPortrait }" role="presentation">
    <svg ref="svg" class="rd-arrow__sketch" aria-hidden="true" />
  </span>
</template>

<style scoped>
.rd-arrow {
  position: relative;
  display: inline-block;
  width: var(--rd-arrow-w, 56px);
  height: var(--rd-arrow-h, 34px);
  vertical-align: middle;
}

/* A vertical arrow in a landscape box draws as a stub, so the axis picks the box. */
.rd-arrow--portrait {
  width: var(--rd-arrow-h, 26px);
  height: var(--rd-arrow-w, 46px);
}

.rd-arrow__sketch {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
</style>
