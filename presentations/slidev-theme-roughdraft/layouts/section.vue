<script setup lang="ts">
import { computed } from 'vue'
import { useSlideContext } from '@slidev/client'

const { $frontmatter } = useSlideContext()
const pen = computed(() => ($frontmatter?.pen as string | undefined) ?? 'blue')
</script>

<template>
  <div class="slidev-layout rd-section">
    <RoughRule class="rd-section__rule" :pen="pen" seed="section-rule" :weight="2.6" />
    <div class="rd-section__body" :style="{ '--rd-section-pen': `var(--rd-pen-${pen}-ink)` }">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.rd-section {
  display: grid;
  grid-template-rows: auto 1fr;
  gap: var(--rd-step-4);
  height: 100%;
}

.rd-section__rule {
  width: 8rem;
}

.rd-section__body {
  align-content: center;
  display: grid;
}

.rd-section__body :deep(h1) {
  max-width: 24ch;
  margin: 0;
  font-size: var(--rd-fs-display);
  line-height: 1.04;
  letter-spacing: -0.034em;
  color: var(--rd-section-pen);
}

.rd-section__body :deep(p) {
  max-width: 46ch;
  margin-top: var(--rd-step-3);
  font-family: var(--rd-font-hand);
  font-size: var(--rd-fs-lead);
  font-weight: 500;
  line-height: 1.4;
  color: var(--rd-ink-2);
}
</style>
