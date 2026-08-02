<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { highContrast } from './contrast'
import { seedFrom, strokeOptions, useSketch } from './rough'

const props = withDefaults(defineProps<{
  pen?: 'ink' | 'blue' | 'red' | 'violet' | 'quiet'
  weight?: number
  seed?: string
}>(), {
  pen: 'quiet',
  weight: 1.8,
  seed: 'rule',
})

const host = ref<HTMLElement>()
const svg = ref<SVGSVGElement>()
const seed = computed(() => seedFrom(`${props.seed}:${props.pen}`))

useSketch(host, svg, (rc, w, h, el) => [
  rc.line(0, h / 2, w, h / 2 - 1, strokeOptions(el, {
    seed: seed.value,
    stroke: `var(--rd-pen-${props.pen})`,
    strokeWidth: props.weight,
    roughness: 0.9,
    disableMultiStroke: true,
  })),
], [toRef(highContrast)])
</script>

<template>
  <div ref="host" class="rd-rule" role="separator">
    <svg ref="svg" class="rd-rule__sketch" aria-hidden="true" />
  </div>
</template>

<style scoped>
.rd-rule {
  position: relative;
  width: 100%;
  height: 8px;
}

.rd-rule__sketch {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
</style>
