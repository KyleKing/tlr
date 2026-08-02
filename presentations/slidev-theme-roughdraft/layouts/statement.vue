<template>
  <div class="slidev-layout rd-statement">
    <div class="rd-statement__body">
      <slot />
    </div>
    <div v-if="$slots.support" class="rd-statement__support">
      <slot name="support" />
    </div>
  </div>
</template>

<style scoped>
.rd-statement {
  display: grid;
  align-content: center;
  gap: var(--rd-step-4);
  height: 100%;
  padding-inline: calc(var(--rd-pad-x) + 1.5rem);
}

/* Line-height is looser than h1 elsewhere: a statement slide is where circled and
   underlined marks live, and those need vertical room between lines to not collide. */
.rd-statement__body :deep(h1),
.rd-statement__body :deep(h2) {
  max-width: 30ch;
  margin: 0;
  font-size: 56px;
  font-weight: 800;
  line-height: 1.24;
  letter-spacing: -0.032em;
}

.rd-statement__body :deep(p) {
  max-width: 34ch;
  margin: var(--rd-step-3) 0 0;
  font-size: var(--rd-fs-lead);
  line-height: 1.4;
  color: var(--rd-ink-2);
}

.rd-statement__support {
  display: flex;
  align-items: flex-start;
  gap: var(--rd-step-4);
}
</style>
