import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { h } from 'vue'
import HomeTitle from './HomeTitle.vue'
import VitePressMermaid from './VitePressMermaid.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('VitePressMermaid', VitePressMermaid)
  },
  Layout: () => h(DefaultTheme.Layout, null, {
    'home-hero-info': () => h(HomeTitle),
  }),
} satisfies Theme
