<template>
  <div class="slidev-layout rd-cols">
    <div v-if="$slots.title" class="rd-cols__title">
      <slot name="title" />
    </div>
    <div class="rd-cols__grid">
      <div class="rd-cols__col">
        <slot name="left">
          <slot />
        </slot>
      </div>
      <div class="rd-cols__col">
        <slot name="right" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.rd-cols {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  align-content: start;
  gap: var(--rd-step-3);
  height: 100%;
}

.rd-cols__title :deep(h1) {
  margin-bottom: 0;
}

/* Centred in the space the title leaves, so a four-label slide does not sit in the
   top half with a third of the canvas empty underneath it. */
.rd-cols__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: var(--rd-step-5);
  align-content: center;
  padding-bottom: var(--rd-step-4);
}

.rd-cols__col {
  min-width: 0;
}

.rd-cols__col :deep(p),
.rd-cols__col :deep(ul),
.rd-cols__col :deep(ol) {
  max-width: 38ch;
}

.rd-cols__col :deep(h2),
.rd-cols__col :deep(h3) {
  margin-top: 0;
}
</style>
