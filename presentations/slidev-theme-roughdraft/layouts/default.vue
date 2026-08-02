<template>
  <div class="slidev-layout rd-default">
    <div class="rd-default__body">
      <slot />
    </div>
    <div v-if="$slots.margin" class="rd-default__margin">
      <slot name="margin" />
    </div>
  </div>
</template>

<style scoped>
.rd-default {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-content: start;
  column-gap: var(--rd-step-5);
  height: 100%;
}

.rd-default__body {
  min-width: 0;
}

.rd-default__margin {
  align-self: end;
  width: 15rem;
  padding-bottom: var(--rd-step-2);
}
</style>
