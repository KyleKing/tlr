<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { highContrast } from './contrast'
import { roundedRectPath, seedFrom, strokeOptions, useSketch } from './rough'

const props = withDefaults(defineProps<{
  pen?: 'ink' | 'blue' | 'red' | 'violet' | 'quiet'
  radius?: number
  weight?: number
  fill?: boolean
  seed?: string
  inset?: number
}>(), {
  pen: 'ink',
  radius: 14,
  weight: 1.9,
  fill: false,
  seed: 'box',
  inset: 0,
})

const host = ref<HTMLElement>()
const svg = ref<SVGSVGElement>()
const seed = computed(() => seedFrom(`${props.seed}:${props.pen}:${props.radius}`))

useSketch(host, svg, (rc, w, h, el) => {
  const pad = props.weight + 1 + props.inset
  const path = roundedRectPath(pad, pad, w - pad * 2, h - pad * 2, props.radius)
  // Rounded corners overshoot badly at the house roughness, so boxes draw calmer
  // than freehand marks do. The wobble still reads; the corners stop growing ears.
  return [rc.path(path, strokeOptions(el, {
    seed: seed.value,
    stroke: `var(--rd-pen-${props.pen})`,
    strokeWidth: props.weight,
    roughness: 0.72,
    bowing: 0.6,
    fill: props.fill ? `var(--rd-wash-${props.pen})` : undefined,
    fillStyle: 'solid',
  }))]
}, [toRef(highContrast)])
</script>

<template>
  <div ref="host" class="rd-box">
    <svg ref="svg" class="rd-box__sketch" aria-hidden="true" />
    <div class="rd-box__body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.rd-box {
  position: relative;
  display: block;
}

.rd-box__sketch {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

.rd-box__body {
  position: relative;
  padding: var(--rd-box-pad, 18px 22px);
}
</style>
