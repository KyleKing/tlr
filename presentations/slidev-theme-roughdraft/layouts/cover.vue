<script setup lang="ts">
import { computed } from 'vue'
import { useSlideContext } from '@slidev/client'

const { $frontmatter } = useSlideContext()
const meta = computed(() => ($frontmatter?.meta as string[] | undefined) ?? [])
</script>

<template>
  <div class="slidev-layout rd-cover">
    <div class="rd-cover__head">
      <slot />
    </div>

    <div class="rd-cover__foot">
      <RoughBox v-if="meta.length" class="rd-cover__meta" pen="quiet" seed="cover-meta" :radius="9" :weight="1.8">
        <ul class="rd-cover__meta-list">
          <li v-for="item in meta" :key="item">{{ item }}</li>
        </ul>
      </RoughBox>
      <div v-if="$slots.note" class="rd-cover__note">
        <slot name="note" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.rd-cover {
  display: grid;
  grid-template-rows: 1fr auto;
  gap: var(--rd-step-4);
  height: 100%;
  padding-right: calc(var(--rd-pad-x) + 6rem);
}

.rd-cover__head {
  align-self: center;
}

.rd-cover__head :deep(h1) {
  margin-bottom: var(--rd-step-3);
  font-size: var(--rd-fs-display);
  font-weight: 800;
  line-height: 1.02;
  letter-spacing: -0.035em;
}

.rd-cover__head :deep(p) {
  max-width: 44ch;
  font-size: var(--rd-fs-lead);
  line-height: 1.4;
  color: var(--rd-ink-2);
}

.rd-cover__foot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--rd-step-4);
}

.rd-cover__meta {
  --rd-box-pad: 9px 16px;
  flex: none;
}

.rd-cover__meta-list {
  display: flex;
  gap: var(--rd-step-3);
  max-width: none;
  margin: 0;
  padding: 0;
  list-style: none;
  font-family: var(--rd-font-mono);
  font-size: var(--rd-fs-meta);
  font-variation-settings: 'MONO' 1, 'CASL' 0.4;
  color: var(--rd-ink-2);
}

.rd-cover__meta-list li {
  margin: 0;
}

.rd-cover__meta-list li::before {
  content: none;
}

.rd-cover__note {
  flex: none;
}
</style>
