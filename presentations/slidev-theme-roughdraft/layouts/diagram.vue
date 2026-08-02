<template>
  <!--
    The layout the theme exists for: labelled boxes on a canvas with drawn connectors.
    The canvas centres in whatever the title leaves, so a topology never sits in the
    top half with dead space beneath it.
  -->
  <div class="slidev-layout rd-diagram">
    <div v-if="$slots.title" class="rd-diagram__title">
      <slot name="title" />
    </div>
    <div class="rd-diagram__canvas">
      <slot />
    </div>
    <div v-if="$slots.foot" class="rd-diagram__foot">
      <slot name="foot" />
    </div>
  </div>
</template>

<style scoped>
.rd-diagram {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: var(--rd-step-3);
  height: 100%;
}

.rd-diagram__title :deep(h1) {
  margin-bottom: 0;
}

.rd-diagram__canvas {
  display: grid;
  align-content: center;
  min-height: 0;
}

.rd-diagram__foot {
  display: flex;
  align-items: center;
  gap: var(--rd-step-3);
  font-size: var(--rd-fs-meta);
  color: var(--rd-ink-2);
}

/* Node labels inside a diagram are the hand-face label voice, held tight so a
   two-word label never wraps into the connector. */
.rd-diagram__canvas :deep(.rd-node) {
  --rd-box-pad: 10px 16px;
}

.rd-diagram__canvas :deep(.rd-node__label) {
  margin: 0;
  font-family: var(--rd-font-hand);
  font-size: 20px;
  font-weight: 700;
  line-height: 1.16;
  text-wrap: balance;
}

.rd-diagram__canvas :deep(.rd-node__meta) {
  margin: 2px 0 0;
  font-family: var(--rd-font-mono);
  font-size: 14px;
  font-variation-settings: 'MONO' 1, 'CASL' 0.4;
  color: var(--rd-ink-2);
}
</style>
