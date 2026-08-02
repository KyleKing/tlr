<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { highContrast } from './contrast'
import { seedFrom, strokeOptions, useSketch } from './rough'

const props = withDefaults(defineProps<{
  as?: 'underline' | 'circle' | 'bracket' | 'strike'
  pen?: 'ink' | 'blue' | 'red' | 'violet' | 'quiet'
  weight?: number
  seed?: string
}>(), {
  as: 'underline',
  pen: 'blue',
  weight: 2.4,
  seed: 'mark',
})

const host = ref<HTMLElement>()
const svg = ref<SVGSVGElement>()
const seed = computed(() => seedFrom(`${props.seed}:${props.as}:${props.pen}`))

useSketch(host, svg, (rc, w, h, el) => {
  const opts = strokeOptions(el, {
    seed: seed.value,
    stroke: `var(--rd-pen-${props.pen})`,
    strokeWidth: props.weight,
  })

  if (props.as === 'circle') {
    return [rc.ellipse(w / 2, h / 2, w * 0.99, h * 0.94, { ...opts, roughness: 1.35 })]
  }

  if (props.as === 'strike') {
    return [rc.line(2, h * 0.56, w - 2, h * 0.52, opts)]
  }

  if (props.as === 'bracket') {
    const lip = Math.min(10, w * 0.22)
    return [
      rc.linearPath([[lip, 2], [2, 2], [2, h - 2], [lip, h - 2]], opts),
      rc.linearPath([[w - lip, 2], [w - 2, 2], [w - 2, h - 2], [w - lip, h - 2]], opts),
    ]
  }

  const y = h * 0.97
  return [rc.line(1, y, w - 1, y - 1.5, { ...opts, roughness: 1.4 })]
}, [toRef(highContrast)])
</script>

<template>
  <span ref="host" class="rd-mark" :class="`rd-mark--${props.as}`">
    <svg ref="svg" class="rd-mark__sketch" aria-hidden="true" />
    <span class="rd-mark__body"><slot /></span>
  </span>
</template>

<style scoped>
.rd-mark {
  position: relative;
  display: inline-block;
}

.rd-mark__sketch {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

.rd-mark--underline .rd-mark__sketch {
  top: 0.14em;
}

/* The ellipse is drawn inside the element box, so the box has to be bigger than the
   glyphs it rings or the stroke crosses the text and the line below it. */
.rd-mark--circle {
  padding: 0.24em 0.34em;
  margin: 0 -0.1em;
}

.rd-mark--bracket {
  padding: 0 0.42em;
}

.rd-mark__body {
  position: relative;
}
</style>
