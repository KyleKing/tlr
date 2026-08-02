<template>
  <div class="slidev-layout rd-choices">
    <div v-if="$slots.title" class="rd-choices__title">
      <slot name="title" />
    </div>
    <div class="rd-choices__stack">
      <slot />
    </div>
    <div v-if="$slots.foot" class="rd-choices__foot">
      <slot name="foot" />
    </div>
  </div>
</template>

<style scoped>
.rd-choices {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  align-content: start;
  gap: var(--rd-step-3);
  height: 100%;
}

.rd-choices__title :deep(h1) {
  margin-bottom: 0;
}

/*
 * Rows separated by a rough rule rather than boxed as equal cards, so the
 * recommendation can take more weight than the alternatives it beat.
 */
.rd-choices__stack {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: var(--rd-step-2);
  min-height: 0;
}

.rd-choices__stack :deep(.rd-choice:not(.rd-choice--pick)) {
  padding-block: var(--rd-step-1);
}

.rd-choices__foot {
  display: flex;
  align-items: center;
  margin-top: var(--rd-step-3);
  gap: var(--rd-step-3);
  font-size: var(--rd-fs-meta);
  color: var(--rd-ink-2);
}
</style>
