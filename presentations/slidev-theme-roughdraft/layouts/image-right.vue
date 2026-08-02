<script setup lang="ts">
import { computed } from 'vue'
import { useSlideContext } from '@slidev/client'

const { $frontmatter } = useSlideContext()
const image = computed(() => $frontmatter?.image as string | undefined)
const alt = computed(() => ($frontmatter?.alt as string | undefined) ?? '')
const caption = computed(() => $frontmatter?.caption as string | undefined)
</script>

<template>
  <div class="slidev-layout rd-image">
    <div class="rd-image__body">
      <slot />
    </div>
    <figure class="rd-image__figure">
      <RoughBox class="rd-image__frame" pen="quiet" seed="image-frame" :radius="12" :weight="1.6">
        <img v-if="image" :src="image" :alt="alt">
        <slot v-else name="media" />
      </RoughBox>
      <figcaption v-if="caption">{{ caption }}</figcaption>
    </figure>
  </div>
</template>

<style scoped>
.rd-image {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr);
  align-content: start;
  column-gap: var(--rd-step-5);
  height: 100%;
}

.rd-image__body {
  min-width: 0;
}

.rd-image__body :deep(p),
.rd-image__body :deep(ul) {
  max-width: 34ch;
}

.rd-image__figure {
  display: flex;
  flex-direction: column;
  gap: var(--rd-step-2);
  align-self: center;
  margin: 0;
  min-width: 0;
}

.rd-image__frame {
  --rd-box-pad: 8px;
}

.rd-image__frame :deep(img),
.rd-image__frame :deep(video) {
  display: block;
  width: 100%;
  border-radius: 7px;
}

figcaption {
  font-family: var(--rd-font-hand);
  font-size: var(--rd-fs-note);
  font-weight: 500;
  line-height: 1.38;
  color: var(--rd-ink-2);
}
</style>
