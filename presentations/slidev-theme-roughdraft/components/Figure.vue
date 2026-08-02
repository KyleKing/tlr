<script setup lang="ts">
const props = withDefaults(defineProps<{
  pen?: 'ink' | 'blue' | 'red' | 'violet'
  circled?: boolean
}>(), {
  pen: 'ink',
  circled: false,
})
</script>

<template>
  <Mark v-if="props.circled" as="circle" :pen="props.pen" seed="figure" class="rd-figure-mark">
    <span class="rd-figure" :style="{ '--rd-figure-pen': `var(--rd-pen-${props.pen}-ink)` }"><slot /></span>
  </Mark>
  <span v-else class="rd-figure" :style="{ '--rd-figure-pen': `var(--rd-pen-${props.pen}-ink)` }"><slot /></span>
</template>

<style scoped>
.rd-figure {
  font-family: var(--rd-font-sans);
  font-size: 1.85em;
  font-weight: 800;
  line-height: 0.9;
  letter-spacing: -0.025em;
  color: var(--rd-figure-pen);
  font-variant-numeric: lining-nums tabular-nums;
}

.rd-figure-mark {
  margin: 0 0.1em;
}
</style>
