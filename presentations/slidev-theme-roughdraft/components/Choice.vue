<script setup lang="ts">
import RoughBox from './RoughBox.vue'

const props = withDefaults(defineProps<{
  name: string
  pen?: 'ink' | 'blue' | 'red' | 'violet'
  pick?: boolean
  cost?: string
}>(), {
  pen: 'ink',
  pick: false,
})
</script>

<template>
  <component
    :is="props.pick ? RoughBox : 'div'"
    v-bind="props.pick ? { pen: props.pen, seed: `choice-${props.name}`, radius: 12, fill: true } : {}"
    class="rd-choice"
    :class="{ 'rd-choice--pick': props.pick }"
  >
    <div class="rd-choice__grid">
      <h3 class="rd-choice__name" :style="{ '--rd-choice-pen': `var(--rd-pen-${props.pen}-ink)` }">
        {{ props.name }}
      </h3>
      <p v-if="props.cost" class="rd-choice__cost">{{ props.cost }}</p>
      <div class="rd-choice__body">
        <slot />
      </div>
    </div>
  </component>
</template>

<style scoped>
.rd-choice {
  --rd-box-pad: 14px 20px 16px;
}

.rd-choice__grid {
  display: grid;
  grid-template-columns: minmax(0, 10.5rem) minmax(0, 1fr);
  grid-template-areas:
    'name body'
    'cost body';
  align-items: baseline;
  column-gap: 28px;
  row-gap: 2px;
}

.rd-choice__name {
  grid-area: name;
  margin: 0;
  font-family: var(--rd-font-hand);
  font-size: 22px;
  font-weight: 700;
  line-height: 1.14;
  color: var(--rd-choice-pen);
  text-wrap: balance;
}

.rd-choice__cost {
  grid-area: cost;
  margin: 0;
  font-family: var(--rd-font-mono);
  font-size: var(--rd-fs-meta);
  font-variation-settings: 'MONO' 1, 'CASL' 0.4;
  color: var(--rd-ink-2);
}

.rd-choice__body {
  grid-area: body;
}

.rd-choice__body :deep(p) {
  margin: 0 0 0.35em;
}

.rd-choice__body :deep(p:last-child) {
  margin-bottom: 0;
}

.rd-choice--pick .rd-choice__grid {
  padding-block: 2px;
}
</style>
