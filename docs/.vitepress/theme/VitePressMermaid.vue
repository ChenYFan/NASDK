<script setup lang="ts">
import { useData } from 'vitepress'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ value: string }>()
const { isDark } = useData()
const root = ref<HTMLElement>()
const svg = ref('')
const minHeight = ref('160px')
const visible = ref(false)
let observer: IntersectionObserver | undefined
let renderId = 0

async function render() {
  if (!visible.value) return
  const id = ++renderId
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({ startOnLoad: false, theme: isDark.value ? 'dark' : 'default' })
  const result = await mermaid.render(`mermaid-${id}`, props.value)
  if (id !== renderId) return
  svg.value = result.svg
  await nextTick()
  const height = root.value?.getBoundingClientRect().height
  if (height) minHeight.value = `${height}px`
}

watch(isDark, () => { void render() })
watch(() => props.value, () => { void render() })

onMounted(() => {
  observer = new IntersectionObserver(([entry]) => {
    if (!entry?.isIntersecting) return
    visible.value = true
    observer?.disconnect()
    void render()
  }, { rootMargin: '240px' })
  if (root.value) observer.observe(root.value)
})

onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div
    ref="root"
    class="vitepress-mermaid"
    :style="{ minHeight }"
    v-html="svg"
  />
</template>

<style scoped>
.vitepress-mermaid {
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 16px 0;
  overflow-x: auto;
  transition: min-height 200ms ease;
}

.vitepress-mermaid :deep(svg) {
  max-width: 100%;
  height: auto;
}
</style>
