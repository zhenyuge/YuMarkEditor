// Lazily loaded renderers: KaTeX, highlight.js, Mermaid, DOMPurify.
// Nothing heavy is loaded until a document actually needs it.

type Katex = typeof import('katex').default
type Hljs = typeof import('highlight.js').default

let katexP: Promise<Katex> | null = null
let katexMod: Katex | null = null
export function loadKatex(): Promise<Katex> {
  return (katexP ??= import('katex').then(m => (katexMod = m.default)))
}

export function renderMathInto(el: HTMLElement, tex: string, display: boolean) {
  const run = (k: Katex) => {
    try {
      k.render(tex || '\\,', el, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'html', trust: false })
      el.classList.remove('math-error')
    } catch (e: any) {
      el.textContent = tex
      el.classList.add('math-error')
      el.title = String(e?.message || e)
    }
  }
  if (katexMod) run(katexMod)
  else { el.textContent = tex; loadKatex().then(run) }
}

export function mathToString(tex: string, display: boolean, output: 'html' | 'mathml' = 'html'): string {
  if (!katexMod) throw new Error('katex not loaded')
  return katexMod.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', output })
}

// ------------------------------------------------------------ highlight.js
let hljsP: Promise<Hljs> | null = null
export let hljs: Hljs | null = null
export function loadHljs(): Promise<Hljs> {
  return (hljsP ??= import('highlight.js/lib/common').then(m => (hljs = m.default)))
}

export interface HlRange { from: number; to: number; cls: string }

const hlCache = new Map<string, HlRange[]>()

export function highlightRanges(code: string, lang: string): HlRange[] | null {
  if (!hljs) return null
  if (!lang || !hljs.getLanguage(lang)) return []
  const key = lang + '\u0000' + code
  const hit = hlCache.get(key)
  if (hit) return hit
  let html: string
  try { html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value } catch { return [] }
  const ranges: HlRange[] = []
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  let pos = 0
  const walk = (node: Node, classes: string[]) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        const len = c.textContent!.length
        if (classes.length && len) ranges.push({ from: pos, to: pos + len, cls: classes.join(' ') })
        pos += len
      } else if (c.nodeType === 1) {
        const cls = (c as Element).className
        walk(c, cls ? [...classes, cls] : classes)
      }
    }
  }
  walk(tpl.content, [])
  if (hlCache.size > 500) hlCache.clear()
  hlCache.set(key, ranges)
  return ranges
}

export function highlightHTML(code: string, lang: string): string {
  if (hljs && lang && hljs.getLanguage(lang)) {
    try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value } catch {}
  }
  return code.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
}

// ------------------------------------------------------------ Mermaid
let mermaidP: Promise<any> | null = null
let mermaidTheme = ''
export function loadMermaid(): Promise<any> {
  return (mermaidP ??= import(/* @vite-ignore */ (new URL('vendor/mermaid/mermaid.esm.min.mjs', document.baseURI).href) as string)
    .then(m => m.default))
}

let queue: Promise<unknown> = Promise.resolve()
let counter = 0

export function isDark() {
  return document.documentElement.dataset.theme === 'dark' ||
    (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
}

/** Render a Mermaid diagram to an SVG string (serialized, one at a time). */
export function renderMermaid(code: string, opts: { theme?: 'default' | 'dark'; htmlLabels?: boolean } = {}): Promise<string> {
  const job = queue.then(async () => {
    const mermaid = await loadMermaid()
    const theme = opts.theme || (isDark() ? 'dark' : 'default')
    const key = theme + (opts.htmlLabels === false ? '-nohtml' : '')
    if (mermaidTheme !== key) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme,
        fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif',
        htmlLabels: opts.htmlLabels !== false,
        flowchart: { htmlLabels: opts.htmlLabels !== false },
      })
      mermaidTheme = key
    }
    const id = 'mmd-' + ++counter
    try {
      const { svg } = await mermaid.render(id, code)
      return svg as string
    } finally {
      document.getElementById(id)?.remove()
      document.getElementById('d' + id)?.remove()
    }
  })
  queue = job.catch(() => {})
  return job
}

// ------------------------------------------------------------ DOMPurify
type Purify = typeof import('dompurify').default
let purifyP: Promise<Purify> | null = null
export let purify: Purify | null = null
export function loadPurify(): Promise<Purify> {
  return (purifyP ??= import('dompurify').then(m => {
    purify = m.default
    purify.addHook('afterSanitizeAttributes', node => {
      if (node.tagName === 'A') node.setAttribute('target', '_blank')
    })
    return purify
  }))
}

export function sanitize(html: string): string {
  if (!purify) return ''
  return purify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_TAGS: ['details', 'summary', 'kbd', 'mark', 'sub', 'sup', 'center', 'font'],
    ADD_ATTR: ['align', 'open', 'color', 'face', 'size', 'target'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'style', 'link', 'meta', 'base'],
  }) as unknown as string
}
