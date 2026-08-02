<template>
  <div class="slidev-layout rd-end">
    <div class="rd-end__body">
      <slot />
    </div>
    <div v-if="$slots.asks" class="rd-end__asks">
      <RoughRule class="rd-end__rule" pen="quiet" seed="end-rule" />
      <slot name="asks" />
    </div>
  </div>
</template>

<style scoped>
.rd-end {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  align-content: center;
  column-gap: var(--rd-step-5);
  height: 100%;
}

.rd-end__body :deep(h1) {
  max-width: 20ch;
  margin: 0;
  font-size: 52px;
  line-height: 1.08;
  letter-spacing: -0.03em;
}

.rd-end__body :deep(p) {
  max-width: 32ch;
  margin: var(--rd-step-3) 0 0;
  font-family: var(--rd-font-hand);
  font-size: var(--rd-fs-lead);
  font-weight: 500;
  line-height: 1.4;
  color: var(--rd-ink-2);
}

.rd-end__asks {
  align-self: center;
}

.rd-end__rule {
  width: 5rem;
  margin-bottom: var(--rd-step-3);
}

.rd-end__asks :deep(ol),
.rd-end__asks :deep(ul) {
  max-width: 34ch;
  margin: 0;
}

.rd-end__asks :deep(li) {
  margin-bottom: var(--rd-step-3);
}
</style>
