// Render a markdown document to a standalone, self-contained HTML page
// (images, formula fonts and diagrams inlined) for HTML / PDF / image export.
import { createMarkdown } from '../md/markdown'
import { calloutIcons, calloutKind, CALLOUT_LABEL } from '../icons'
import { highlightHTML, loadHljs, loadKatex, loadPurify, renderMermaid } from '../render'
import { escapeHTML, resolveSrc, toBase64 } from '../util'

export type ExportPurpose = 'html' | 'pdf' | 'image'

const emd = createMarkdown()

export function slugify(text: string, used: Map<string, number>): string {
  let s = text.trim().toLowerCase()
    .replace(/[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
    .replace(/\s+/g, '-')
  if (!s) s = 'section'
  const n = used.get(s) || 0
  used.set(s, n + 1)
  return n ? `${s}-${n}` : s
}

function inlineText(tok: any): string {
  return (tok.children || []).map((c: any) => (c.type === 'text' || c.type === 'code_inline' ? c.content : c.type === 'image' ? '' : c.content || '')).join('')
}

async function fileToDataURL(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    const buf = await blob.arrayBuffer()
    let mime = blob.type
    if (!mime || mime === 'application/octet-stream') {
      const ext = url.split('?')[0].split('.').pop()!.toLowerCase()
      mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', heic: 'image/heic' } as any)[ext] || 'application/octet-stream'
    }
    return `data:${mime};base64,${toBase64(buf)}`
  } catch {
    return null
  }
}

export interface RenderResult { body: string; hasMath: boolean; title: string | null }

export async function renderBody(text: string, docDir: string | null, purpose: ExportPurpose): Promise<RenderResult> {
  const env: any = {}
  const tokens = emd.parse(text, env)
  let hasMath = false, hasCode = false
  const mermaid: string[] = []
  const images = new Map<string, string>()
  const imageJobs: Promise<void>[] = []
  const headings: { level: number; text: string; id: string }[] = []
  const used = new Map<string, number>()
  let firstH1: string | null = null

  const visit = (toks: any[]) => {
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]
      if (t.type === 'math_block' || t.type === 'math_inline') hasMath = true
      if (t.type === 'fence') {
        const lang = (t.info || '').trim().split(/\s+/)[0].toLowerCase()
        if (lang === 'math' || lang === 'katex') hasMath = true
        else if (lang !== 'mermaid') hasCode = true
      }
      if (t.type === 'heading_open') {
        const txt = inlineText(toks[i + 1])
        const id = slugify(txt, used)
        t.attrSet('id', id)
        headings.push({ level: +t.tag.slice(1), text: txt, id })
        if (!firstH1 && t.tag === 'h1') firstH1 = txt
      }
      if (t.type === 'image') {
        const src = t.attrGet('src') || ''
        if (!images.has(src)) {
          images.set(src, src)
          const url = resolveSrc(decodeSafe(src), docDir)
          if (url && !/^data:/.test(url) && (url.startsWith('/@fs') || purpose !== 'html')) {
            imageJobs.push(fileToDataURL(url).then(d => { if (d) images.set(src, d) }))
          }
        }
      }
      if (t.children) visit(t.children)
    }
  }
  visit(tokens)

  await Promise.all([
    hasMath ? loadKatex() : null,
    hasCode ? loadHljs() : null,
    loadPurify(),
    ...imageJobs,
  ])
  const katex = hasMath ? (await loadKatex()) : null

  const math = (tex: string, display: boolean) => {
    try { return katex!.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'html' }) }
    catch { return `<code>${escapeHTML(tex)}</code>` }
  }

  const r = emd.renderer.rules as any
  const fnOrder = new Map<string, number>()
  const fnRefCount = new Map<string, number>()
  r.front_matter = () => ''
  r.ref_def = () => ''
  r.toc = () => '<nav class="toc" data-toc="1"></nav>\n'
  r.math_inline = (t: any[], i: number) => math(t[i].content, t[i].markup === '$$')
  r.math_block = (t: any[], i: number) => `<div class="math-display">${math(t[i].content, true)}</div>\n`
  r.footnote_ref = (t: any[], i: number) => {
    const label = t[i].meta.label
    if (!fnOrder.has(label)) fnOrder.set(label, fnOrder.size + 1)
    const n = fnOrder.get(label)!
    const k = (fnRefCount.get(label) || 0) + 1
    fnRefCount.set(label, k)
    const id = encodeURIComponent(label)
    return `<sup class="fn-ref"><a href="#fn-${id}" id="fnref-${id}${k > 1 ? '-' + k : ''}">${n}</a></sup>`
  }
  r.footnote_def_open = (t: any[], i: number) => `<div class="fn-def" data-label="${escapeHTML(t[i].meta.label)}">`
  r.footnote_def_close = () => '</div>\n'
  r.callout_open = (t: any[], i: number) => {
    const meta = t[i].meta
    const kind = calloutKind(meta.kind)
    const title = meta.title || CALLOUT_LABEL[kind] || meta.kind
    return `<div class="callout" data-kind="${kind}"><div class="callout-title"><span class="callout-icon">${calloutIcons[kind]}</span><span>${emd.renderInline(title)}</span></div><div class="callout-body">\n`
  }
  r.callout_close = () => '</div></div>\n'
  r.fence = (t: any[], i: number) => {
    const tok = t[i]
    const lang = (tok.info || '').trim().split(/\s+/)[0]
    const l = lang.toLowerCase()
    if (l === 'mermaid') {
      mermaid.push(tok.content)
      return `<div class="mermaid" data-mermaid="${mermaid.length - 1}"></div>\n`
    }
    if (l === 'math' || l === 'katex') return `<div class="math-display">${math(tok.content, true)}</div>\n`
    return `<pre class="code-block"><code class="hljs${lang ? ' language-' + escapeHTML(lang) : ''}">${highlightHTML(tok.content.replace(/\n$/, ''), l)}</code></pre>\n`
  }
  r.code_block = (t: any[], i: number) => `<pre class="code-block"><code>${escapeHTML(t[i].content.replace(/\n$/, ''))}</code></pre>\n`
  const defaultListItem = r.list_item_open || ((t: any[], i: number, o: any, _e: any, self: any) => self.renderToken(t, i, o))
  r.list_item_open = (t: any[], i: number, o: any, e: any, self: any) => {
    const checked = t[i].meta?.checked
    if (checked == null) return defaultListItem(t, i, o, e, self)
    t[i].attrJoin('class', 'task-item')
    return self.renderToken(t, i, o) + `<input type="checkbox" disabled${checked ? ' checked' : ''}> `
  }
  r.image = (t: any[], i: number) => {
    const tok = t[i]
    const src = tok.attrGet('src') || ''
    const resolved = images.get(src) || src
    const alt = escapeHTML(tok.children ? tok.children.map((c: any) => c.content).join('') : tok.content)
    const title = tok.attrGet('title')
    return `<img src="${escapeHTML(resolved)}" alt="${alt}"${title ? ` title="${escapeHTML(title)}"` : ''}>`
  }

  let html = emd.renderer.render(tokens, emd.options, env)

  const { sanitize } = await import('dompurify').then(m => ({ sanitize: (s: string) => m.default.sanitize(s, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    ADD_TAGS: ['details', 'summary', 'nav'],
    ADD_ATTR: ['target', 'open', 'data-kind', 'data-label', 'data-mermaid', 'data-toc'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'button', 'textarea', 'select', 'link', 'meta', 'base'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data|file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  }) as unknown as string }))
  html = sanitize(html)

  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const root = tpl.content

  // footnotes: move definitions to the end, numbered by first reference
  const defs = [...root.querySelectorAll('.fn-def')] as HTMLElement[]
  if (defs.length) {
    const ol = document.createElement('ol')
    const byLabel = new Map(defs.map(d => [d.dataset.label!, d]))
    const labels = [...fnOrder.keys()].filter(l => byLabel.has(l))
    for (const l of byLabel.keys()) if (!fnOrder.has(l)) labels.push(l)
    for (const label of labels) {
      const d = byLabel.get(label)!
      const li = document.createElement('li')
      const id = encodeURIComponent(label)
      li.id = 'fn-' + id
      li.append(...d.childNodes)
      const refs = fnRefCount.get(label) || 0
      const target = li.lastElementChild && li.lastElementChild.tagName === 'P' ? li.lastElementChild : li
      for (let k = 1; k <= refs; k++) {
        const a = document.createElement('a')
        a.href = `#fnref-${id}${k > 1 ? '-' + k : ''}`
        a.className = 'fn-back'
        a.textContent = '↩'
        target.append(' ', a)
      }
      ol.append(li)
    }
    defs.forEach(d => d.remove())
    const sec = document.createElement('section')
    sec.className = 'footnotes'
    sec.append(document.createElement('hr'), ol)
    root.append(sec)
  }

  // [TOC]
  root.querySelectorAll('nav[data-toc]').forEach(nav => {
    const min = Math.min(6, ...headings.map(h => h.level))
    nav.innerHTML = '<div class="toc-title">目录</div>' + headings.map(h =>
      `<div class="toc-item" style="padding-left:${(h.level - min) * 16}px"><a href="#${escapeHTML(h.id)}">${escapeHTML(h.text)}</a></div>`).join('')
  })

  // mermaid diagrams (rendered light, inserted after sanitising)
  const slots = [...root.querySelectorAll('[data-mermaid]')] as HTMLElement[]
  for (const slot of slots) {
    const code = mermaid[+slot.dataset.mermaid!]
    try {
      slot.innerHTML = await renderMermaid(code, { theme: 'default' })
    } catch (e: any) {
      slot.innerHTML = `<pre class="code-block"><code>${escapeHTML(code)}</code></pre>`
    }
    slot.removeAttribute('data-mermaid')
  }

  const div = document.createElement('div')
  div.append(root)
  return { body: div.innerHTML, hasMath, title: firstH1 }
}

function decodeSafe(s: string) {
  try { return decodeURI(s) } catch { return s }
}

let cssCache: Record<string, string> = {}
async function asset(name: string): Promise<string> {
  if (cssCache[name] != null) return cssCache[name]
  try {
    const res = await fetch(name)
    cssCache[name] = res.ok ? await res.text() : ''
  } catch {
    cssCache[name] = ''
  }
  return cssCache[name]
}

export async function buildStandaloneHTML(text: string, opts: { title: string; docDir: string | null; purpose: ExportPurpose; width?: number }): Promise<string> {
  const { body, hasMath } = await renderBody(text, opts.docDir, opts.purpose)
  const [content, exportCSS, katexCSS] = await Promise.all([
    asset('content.css'),
    asset('export.css'),
    hasMath ? asset('katex-inline.css') : Promise.resolve(''),
  ])
  const width = opts.width ? `<style>html,body{width:${opts.width}px}</style>` : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="YuMarkEditor">
<title>${escapeHTML(opts.title)}</title>
<style>
${katexCSS}
${content}
${exportCSS}
</style>
${width}
</head>
<body class="export export-${opts.purpose}">
<article class="markdown-body">
${body}
</article>
</body>
</html>
`
}
