<script lang="ts">
let nextMermaidId = 0
let renderQueue = Promise.resolve()

function expandViewBox(source: string, padding = 24): string {
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none'
  container.innerHTML = source
  document.body.append(container)

  try {
    const svg = container.querySelector('svg')
    if (!svg) return source
    svg.style.removeProperty('max-width')
    const bounds = svg.getBBox()
    if (!bounds.width || !bounds.height) return source

    const width = bounds.width + padding * 2
    const height = bounds.height + padding * 2
    svg.setAttribute('viewBox', `${bounds.x - padding} ${bounds.y - padding} ${width} ${height}`)
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))
    return new XMLSerializer().serializeToString(svg)
  } finally {
    container.remove()
  }
}
</script>

<script setup lang="ts">
import { useData } from 'vitepress'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ value: string }>()
const { isDark } = useData()
const root = ref<HTMLElement>()
const image = ref('')
const visible = ref(false)
let observer: IntersectionObserver | undefined
let renderId = 0

async function render() {
  if (!visible.value) return
  const id = ++renderId
  const svgId = `mermaid-${++nextMermaidId}`
  const value = props.value
  const theme = isDark.value ? 'dark' : 'default'
  await document.fonts?.ready
  let rendered = ''
  renderQueue = renderQueue.catch(() => undefined).then(async () => {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({ startOnLoad: false, theme })
    rendered = expandViewBox((await mermaid.render(svgId, value)).svg)
  })
  await renderQueue
  if (id !== renderId) return
  image.value = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered)}`
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
  >
    <img v-if="image" :src="image" alt="" />
  </div>
</template>

<style scoped>
.vitepress-mermaid {
  margin: 16px 0;
  padding: 16px;
  box-sizing: border-box;
  text-align: center;
}

.vitepress-mermaid:empty {
  min-height: 160px;
}

.vitepress-mermaid img {
  display: block;
  width: auto;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
}
</style>
