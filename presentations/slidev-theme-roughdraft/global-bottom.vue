<script setup lang="ts">
import { computed } from 'vue'
import { useNav } from '@slidev/client'
import { highContrast } from './components/contrast'

const { currentPage, total, isPrintMode } = useNav()
const showCounter = computed(() => currentPage.value > 1 && !isPrintMode.value)
</script>

<template>
  <footer class="rd-chrome" aria-hidden="true">
    <span v-if="highContrast" class="rd-chrome__mode">high contrast</span>
    <span v-if="showCounter" class="rd-chrome__count">{{ currentPage }}<span class="rd-chrome__slash">/</span>{{ total }}</span>
  </footer>
</template>

<style scoped>
/* Sits in the slide's own bottom padding, right-aligned to stay clear of Slidev's
   hover nav bar at bottom-left. */
.rd-chrome {
  position: absolute;
  right: var(--rd-pad-x, 60px);
  bottom: 18px;
  display: flex;
  align-items: baseline;
  gap: 14px;
  font-family: var(--rd-font-mono);
  font-size: 13px;
  font-variation-settings: 'MONO' 1, 'CASL' 0.4;
  color: var(--rd-ink-2);
  pointer-events: none;
}

.rd-chrome__mode {
  padding: 2px 7px;
  border: 1px solid var(--rd-pen-quiet);
  border-radius: 5px;
  color: var(--rd-ink-2);
}

.rd-chrome__slash {
  margin: 0 2px;
  opacity: 0.55;
}
</style>
