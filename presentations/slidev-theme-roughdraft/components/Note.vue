<script setup lang="ts">
import RoughArrow from './RoughArrow.vue'

const props = withDefaults(defineProps<{
  pen?: 'ink' | 'blue' | 'red' | 'violet' | 'quiet'
  arrow?: 'right' | 'left' | 'down' | 'up' | 'down-right' | 'down-left' | 'none'
}>(), {
  pen: 'quiet',
  arrow: 'none',
})
</script>

<template>
  <!-- A note is prose, so it takes the text-safe pen variant. The stroke variants are
       tuned for 2px graphics and fall below 4.5:1 as running text on a cast screen. -->
  <aside class="rd-note" :style="{ '--rd-note-pen': `var(--rd-pen-${props.pen}-ink)` }">
    <RoughArrow v-if="props.arrow !== 'none'" class="rd-note__arrow" :dir="props.arrow" :pen="props.pen" />
    <p class="rd-note__text">
      <slot />
    </p>
  </aside>
</template>

<style scoped>
.rd-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 26ch;
}

.rd-note__arrow {
  --rd-arrow-w: 42px;
  --rd-arrow-h: 26px;
  flex: none;
  margin-top: 2px;
}

.rd-note__text {
  margin: 0;
  font-family: var(--rd-font-hand);
  font-size: var(--rd-fs-note);
  font-weight: 500;
  line-height: 1.42;
  color: var(--rd-note-pen);
  text-wrap: pretty;
}
</style>
