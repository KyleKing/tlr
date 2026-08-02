<script setup lang="ts">
import { computed } from 'vue'
import { useSlideContext } from '@slidev/client'

const { $frontmatter } = useSlideContext()
const prompt = computed(() => ($frontmatter?.prompt as string | undefined) ?? '')
</script>

<template>
  <!--
    Scratch space the presenter jumps to mid-discussion. The dot grid is the only
    place the theme uses one: it marks the slide as somewhere to draw, and gives
    freehand strokes something to line up against.
  -->
  <div class="slidev-layout rd-board">
    <header class="rd-board__head">
      <div>
        <h2 v-if="prompt" class="rd-board__prompt">{{ prompt }}</h2>
        <slot />
      </div>
      <p class="rd-board__hint">press <kbd>p</kbd> to draw</p>
    </header>
  </div>
</template>

<style scoped>
.rd-board {
  display: grid;
  grid-template-rows: auto 1fr auto;
  height: 100%;
  background-color: var(--rd-canvas);
  background-image: radial-gradient(var(--rd-pen-quiet) 1.1px, transparent 1.1px);
  background-size: 26px 26px;
  background-position: -13px -13px;
}

/* The grid is guidance, not content, so high-contrast mode holds it at the light
   value instead of following --rd-pen-quiet up to 6:1 and swamping the drawings. */
:root.rd-hc .rd-board {
  background-image: radial-gradient(#c3c9cf 1.3px, transparent 1.3px);
}

.rd-board__head {
  grid-row: 1;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--rd-step-4);
}

.rd-board__prompt {
  max-width: 30ch;
  margin: 0;
  font-family: var(--rd-font-hand);
  font-size: var(--rd-fs-h2);
  font-weight: 700;
  line-height: 1.18;
  color: var(--rd-ink);
}

.rd-board__hint {
  flex: none;
  margin: 0;
  font-family: var(--rd-font-mono);
  font-size: var(--rd-fs-meta);
  font-variation-settings: 'MONO' 1, 'CASL' 0.4;
  color: var(--rd-ink-2);
}

.rd-board__hint kbd {
  padding: 1px 5px;
  border: 1px solid var(--rd-pen-quiet);
  border-radius: 4px;
  font: inherit;
  background: var(--rd-canvas-raised);
}
</style>
