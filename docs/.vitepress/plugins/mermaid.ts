import type MarkdownIt from 'markdown-it'

export function mermaidPlugin(md: MarkdownIt) {
  const fence = md.renderer.rules.fence!

  md.renderer.rules.fence = (...args) => {
    const [tokens, idx] = args
    const token = tokens[idx]
    if (token.info.trim() !== 'mermaid') return fence(...args)

    return `<VitePressMermaid value="${md.utils.escapeHtml(token.content.trim())}" />\n`
  }
}
