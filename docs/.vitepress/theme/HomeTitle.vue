<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import packageJson from '../../../package.json'

const version = packageJson.version

const lines = [
  'for AI Infra',
  'for Agent Runtime',
  'as Full-Duplex Control',
  'as Task Orchestrator',
  'for Pipeline Observation'
]
const active = ref(0)
const text = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let deleting = false

function typeNext() {
  const line = lines[active.value]

  if (!deleting && text.value === line) {
    deleting = true
    timer = setTimeout(typeNext, 4000)
    return
  }

  if (deleting && text.value === '') {
    deleting = false
    active.value = Math.floor(Math.random() * lines.length)
    timer = setTimeout(typeNext, 260)
    return
  }

  text.value = deleting
    ? text.value.slice(0, -1)
    : line.slice(0, text.value.length + 1)
  timer = setTimeout(typeNext, deleting ? 36 : 72)
}

onMounted(() => {
  typeNext()
})

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="home-title">
    <h1 class="home-title__heading">
      <span class="home-title__name">
        Nyirusu Application SDK
        <span class="home-title__version">v{{ version }}</span>
      </span>
      <span class="home-title__line" aria-live="polite">
        <span>Built&nbsp;</span><span class="home-title__typed">{{ text }}</span><span class="home-title__caret" aria-hidden="true"></span>
      </span>
    </h1>
    <p class="home-title__tagline">全双工通信协议与有限资源流式运行时</p>
  </div>
</template>
