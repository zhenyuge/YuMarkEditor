import type { Node as PMNode } from 'prosemirror-model'
import { NodeSelection, TextSelection } from 'prosemirror-state'
import type { Decoration, EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view'
import { codeLang, schema } from '../md/schema'
import { calloutIcons, calloutKind, CALLOUT_LABEL, icons } from '../icons'
import { loadPurify, purify, renderMathInto, renderMermaid, sanitize } from '../render'
import { h, resolveSrc } from '../util'
import { editorCtx } from './context'
import { isPreviewBlock } from './commands'
import { parseYamlLite } from './yaml'

const S = schema.nodes

type GetPos = () => number | undefined

const isEditing = (decos: readonly Decoration[]) => decos.some(d => (d as any).spec?.editing)

/** Put the caret inside a code-bearing block (at its end). */
function focusInside(view: EditorView, getPos: GetPos, atStart = false) {
  const pos = getPos()
  if (pos == null) return
  const node = view.state.doc.nodeAt(pos)
  if (!node) return
  const target = atStart ? pos + 1 : pos + 1 + node.content.size
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)))
  view.focus()
}

// ------------------------------------------------------------------ preview blocks
// math_block / html_block / frontmatter / ```mermaid: source is shown only
// while the caret is inside; otherwise the rendered result.

type PreviewKind = 'math' | 'html' | 'frontmatter' | 'mermaid'

function previewKindOf(node: PMNode): PreviewKind | null {
  if (node.type === S.math_block) return 'math'
  if (node.type === S.html_block) return 'html'
  if (node.type === S.frontmatter) return 'frontmatter'
  if (node.type === S.code_block) {
    const l = codeLang(node.attrs.info)
    if (l === 'mermaid') return 'mermaid'
    if (l === 'math' || l === 'katex') return 'math'
  }
  return null
}

let mermaidTimer = new WeakMap<HTMLElement, any>()
const liveDiagrams = new Set<PreviewBlockView>()

// re-draw diagrams when the system switches between light and dark
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  for (const v of liveDiagrams) { v.lastText = null; v.preview.replaceChildren(); v.render() }
})

class PreviewBlockView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  preview: HTMLElement
  header: HTMLElement | null = null
  langInput: HTMLInputElement | null = null
  kind: PreviewKind
  lastText: string | null = null
  editing = false

  constructor(public node: PMNode, public view: EditorView, public getPos: GetPos, decos: readonly Decoration[]) {
    this.kind = previewKindOf(node)!
    const code = h('code')
    this.contentDOM = code
    const pre = h('pre', { class: 'src' }, code)
    this.preview = h('div', { class: 'preview', contenteditable: 'false' })
    const label = { math: '公式', html: 'HTML', frontmatter: '属性', mermaid: 'Mermaid' }[this.kind]
    this.dom = h('div', { class: `pv-block pv-${this.kind}`, 'data-label': label })
    if (node.type === S.code_block) {
      this.header = this.makeCodeHeader()
      this.dom.append(this.header)
    }
    this.dom.append(pre, this.preview)
    this.preview.addEventListener('mousedown', e => {
      if ((e.target as HTMLElement).closest('a')) return
      e.preventDefault()
      focusInside(this.view, this.getPos)
    })
    this.setEditing(isEditing(decos))
    this.render()
    if (this.kind === 'mermaid') liveDiagrams.add(this)
  }

  destroy() { liveDiagrams.delete(this) }

  makeCodeHeader() {
    const input = h('input', { class: 'code-lang', value: this.node.attrs.info, spellcheck: 'false', placeholder: '语言' }) as HTMLInputElement
    this.langInput = input
    bindLangInput(input, this.view, this.getPos)
    return h('div', { class: 'code-header', contenteditable: 'false' }, input)
  }

  setEditing(on: boolean) {
    this.editing = on
    this.dom.classList.toggle('is-editing', on)
  }

  render() {
    const text = this.node.textContent
    if (text === this.lastText) return
    this.lastText = text
    const p = this.preview
    switch (this.kind) {
      case 'math':
        if (!text.trim()) { p.innerHTML = '<span class="pv-empty">空公式</span>'; break }
        renderMathInto(p, text, true)
        break
      case 'html':
        if (!text.trim()) { p.innerHTML = '<span class="pv-empty">空 HTML</span>'; break }
        if (purify) p.innerHTML = sanitize(text)
        else loadPurify().then(() => { if (this.lastText === text) p.innerHTML = sanitize(text) })
        fixRelativeMedia(p)
        break
      case 'frontmatter':
        renderProps(p, text)
        break
      case 'mermaid': {
        clearTimeout(mermaidTimer.get(p))
        if (!text.trim()) { p.innerHTML = '<span class="pv-empty">空图表</span>'; break }
        const run = () => renderMermaid(text).then(svg => {
          if (this.lastText !== text) return
          p.innerHTML = svg
          p.classList.remove('pv-error')
        }).catch(err => {
          if (this.lastText !== text) return
          p.classList.add('pv-error')
          const msg = String(err?.message || err).split('\n').slice(0, 3).join('\n')
          if (!p.querySelector('svg')) p.textContent = 'Mermaid 语法错误：' + msg
          else p.title = msg
        })
        if (!p.childNodes.length) run()
        else mermaidTimer.set(p, setTimeout(run, 350))
        break
      }
    }
  }

  update(node: PMNode, decos: readonly Decoration[]) {
    if (node.type !== this.node.type || previewKindOf(node) !== this.kind) return false
    this.node = node
    if (this.langInput && document.activeElement !== this.langInput) this.langInput.value = node.attrs.info
    this.setEditing(isEditing(decos))
    this.render()
    return true
  }

  stopEvent(e: Event) {
    return !!this.header && this.header.contains(e.target as Node)
  }

  ignoreMutation(m: ViewMutationRecord) {
    return !this.contentDOM.contains(m.target) && m.type !== 'selection'
  }
}

function bindLangInput(input: HTMLInputElement, view: EditorView, getPos: GetPos) {
  const commit = () => {
    const pos = getPos()
    if (pos == null) return
    const node = view.state.doc.nodeAt(pos)
    if (!node || node.attrs.info === input.value.trim()) return
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, info: input.value.trim() }))
  }
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault()
      commit()
      const pos = getPos()
      if (pos != null) {
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)))
        view.focus()
      }
    }
  })
  input.addEventListener('blur', commit)
}

function fixRelativeMedia(root: HTMLElement) {
  root.querySelectorAll('img[src], source[src], video[src]').forEach(el => {
    const src = el.getAttribute('src')!
    const r = resolveSrc(src, editorCtx.docDir)
    if (r && r !== src) el.setAttribute('src', r)
  })
}

function renderProps(p: HTMLElement, text: string) {
  p.textContent = ''
  const data = parseYamlLite(text)
  if (!data) {
    p.append(h('pre', { class: 'props-raw' }, text || ' '))
    return
  }
  const table = h('div', { class: 'props' })
  if (!data.length) table.append(h('div', { class: 'props-empty' }, '空属性'))
  for (const [k, v] of data) {
    const val = h('div', { class: 'prop-val' })
    if (Array.isArray(v)) {
      if (!v.length) val.append(h('span', { class: 'prop-none' }, '—'))
      for (const item of v) val.append(h('span', { class: 'prop-chip' }, item))
    } else if (v === '') val.append(h('span', { class: 'prop-none' }, '—'))
    else val.append(v)
    table.append(h('div', { class: 'prop-key' }, k), val)
  }
  p.append(table)
}

// ------------------------------------------------------------------ plain code block

class CodeBlockView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  langInput: HTMLInputElement
  header: HTMLElement

  constructor(public node: PMNode, public view: EditorView, public getPos: GetPos) {
    const code = h('code')
    this.contentDOM = code
    this.langInput = h('input', { class: 'code-lang', value: node.attrs.info, spellcheck: 'false', placeholder: '语言' }) as HTMLInputElement
    bindLangInput(this.langInput, view, getPos)
    const copy = h('button', { class: 'code-copy', title: '复制代码', html: icons.copy, tabindex: '-1' })
    copy.addEventListener('mousedown', e => e.preventDefault())
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(this.node.textContent)
      copy.innerHTML = icons.check
      setTimeout(() => (copy.innerHTML = icons.copy), 1200)
    })
    this.header = h('div', { class: 'code-header', contenteditable: 'false' }, this.langInput, copy)
    this.dom = h('div', { class: 'code-block' }, this.header, h('pre', { spellcheck: 'false' }, code))
  }

  update(node: PMNode) {
    if (node.type !== this.node.type || previewKindOf(node)) return false
    this.node = node
    if (document.activeElement !== this.langInput) this.langInput.value = node.attrs.info
    return true
  }

  stopEvent(e: Event) {
    return this.header.contains(e.target as Node)
  }

  ignoreMutation(m: ViewMutationRecord) {
    return this.header.contains(m.target as Node)
  }
}

// ------------------------------------------------------------------ inline math

class MathInlineView implements NodeView {
  dom: HTMLElement
  constructor(public node: PMNode) {
    this.dom = h('span', { class: 'math-inline' })
    renderMathInto(this.dom, node.attrs.tex, node.attrs.markup === '$$')
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    if (node.attrs.tex !== this.node.attrs.tex) renderMathInto(this.dom, node.attrs.tex, node.attrs.markup === '$$')
    this.node = node
    return true
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode') }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode') }
  ignoreMutation() { return true }
}

// ------------------------------------------------------------------ image

class ImageView implements NodeView {
  dom: HTMLElement
  img: HTMLImageElement
  constructor(public node: PMNode) {
    this.img = h('img', { draggable: 'false' }) as HTMLImageElement
    this.dom = h('span', { class: 'image-view' }, this.img)
    this.img.addEventListener('error', () => this.dom.classList.add('broken'))
    this.img.addEventListener('load', () => this.dom.classList.remove('broken'))
    this.set(node)
  }
  set(node: PMNode) {
    const src = resolveSrc(node.attrs.src, editorCtx.docDir)
    this.dom.classList.toggle('broken', !src)
    this.dom.setAttribute('data-src', node.attrs.src)
    if (src) this.img.src = src
    else this.img.removeAttribute('src')
    this.img.alt = node.attrs.alt || ''
    this.img.title = node.attrs.title || ''
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    if (node.attrs.src !== this.node.attrs.src || node.attrs.alt !== this.node.attrs.alt) this.set(node)
    this.node = node
    return true
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode') }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode') }
  ignoreMutation() { return true }
}

// ------------------------------------------------------------------ list item (task)

class ListItemView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  box: HTMLInputElement | null = null
  constructor(public node: PMNode, public view: EditorView, public getPos: GetPos) {
    const checked = node.attrs.checked
    if (checked == null) {
      this.dom = this.contentDOM = h('li')
    } else {
      this.contentDOM = h('div', { class: 'li-content' })
      this.box = h('input', { type: 'checkbox' }) as HTMLInputElement
      this.box.checked = !!checked
      this.box.addEventListener('mousedown', e => e.preventDefault())
      this.box.addEventListener('click', e => {
        e.preventDefault()
        const pos = this.getPos()
        if (pos == null) return
        const n = this.view.state.doc.nodeAt(pos)
        if (!n) return
        this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...n.attrs, checked: !n.attrs.checked }))
      })
      this.dom = h('li', { class: 'task-item', 'data-checked': String(!!checked) },
        h('span', { class: 'task-box', contenteditable: 'false' }, this.box), this.contentDOM)
    }
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    if ((node.attrs.checked == null) !== (this.node.attrs.checked == null)) return false
    this.node = node
    if (this.box) {
      this.box.checked = !!node.attrs.checked
      this.dom.setAttribute('data-checked', String(!!node.attrs.checked))
    }
    return true
  }
  stopEvent(e: Event) { return !!this.box && e.target === this.box }
  ignoreMutation(m: ViewMutationRecord) { return !!this.box && m.target === this.box }
}

// ------------------------------------------------------------------ callout

class CalloutView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  header: HTMLElement
  constructor(public node: PMNode, public view: EditorView, public getPos: GetPos) {
    this.contentDOM = h('div', { class: 'callout-body' })
    this.header = h('div', { class: 'callout-title', contenteditable: 'false' })
    this.dom = h('div', { class: 'callout' }, this.header, this.contentDOM)
    this.header.addEventListener('mousedown', e => {
      e.preventDefault()
      const pos = this.getPos()
      if (pos == null) return
      this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)))
      this.view.focus()
    })
    this.set(node)
  }
  set(node: PMNode) {
    const kind = calloutKind(node.attrs.kind)
    this.dom.setAttribute('data-kind', kind)
    this.dom.setAttribute('data-fold', node.attrs.fold || '')
    this.header.innerHTML = ''
    this.header.append(
      h('span', { class: 'callout-icon', html: calloutIcons[kind] }),
      h('span', { class: 'callout-label' }, node.attrs.title || CALLOUT_LABEL[kind] || node.attrs.kind),
    )
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    if (node.attrs !== this.node.attrs) this.set(node)
    this.node = node
    return true
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode') }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode') }
  stopEvent(e: Event) { return this.header.contains(e.target as Node) && e.type !== 'mousedown' }
  ignoreMutation(m: ViewMutationRecord) { return this.header.contains(m.target as Node) }
}

// ------------------------------------------------------------------ footnotes

class FootnoteDefView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  label: HTMLElement
  constructor(public node: PMNode) {
    this.label = h('span', { class: 'fn-label', contenteditable: 'false' }, `[^${node.attrs.label}]`)
    this.contentDOM = h('div', { class: 'fn-body' })
    this.dom = h('div', { class: 'footnote-def', id: 'fn-' + node.attrs.label }, this.label, this.contentDOM)
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    if (node.attrs.label !== this.node.attrs.label) {
      this.label.textContent = `[^${node.attrs.label}]`
      this.dom.id = 'fn-' + node.attrs.label
    }
    this.node = node
    return true
  }
  ignoreMutation(m: ViewMutationRecord) { return m.target === this.label || this.label.contains(m.target as Node) }
}

class FootnoteRefView implements NodeView {
  dom: HTMLElement
  constructor(public node: PMNode) {
    this.dom = h('sup', { class: 'footnote-ref' }, node.attrs.label)
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.dom.textContent = node.attrs.label
    this.node = node
    return true
  }
  ignoreMutation() { return true }
}

// ------------------------------------------------------------------ TOC

export const tocViews = new Set<TocView>()

class TocView implements NodeView {
  dom: HTMLElement
  constructor(public node: PMNode, public view: EditorView) {
    this.dom = h('div', { class: 'toc-block', contenteditable: 'false' })
    this.dom.addEventListener('mousedown', e => {
      const a = (e.target as HTMLElement).closest('[data-pos]') as HTMLElement | null
      if (!a) return
      e.preventDefault()
      const pos = +a.dataset.pos!
      const dom = this.view.nodeDOM(pos) as HTMLElement | null
      dom?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, pos + 1)))
      this.view.focus()
    })
    tocViews.add(this)
    this.render()
  }
  render() {
    const items: HTMLElement[] = []
    let min = 6
    const heads: { level: number; text: string; pos: number }[] = []
    this.view.state.doc.descendants((n, pos) => {
      if (n.type === S.heading) { heads.push({ level: n.attrs.level, text: n.textContent, pos }); min = Math.min(min, n.attrs.level) }
      return n.type !== S.heading && !n.isTextblock
    })
    for (const hd of heads) {
      items.push(h('div', { class: 'toc-item', 'data-pos': String(hd.pos), style: { paddingLeft: (hd.level - min) * 16 + 'px' } }, hd.text || '（无标题）'))
    }
    this.dom.replaceChildren(h('div', { class: 'toc-title' }, '目录'), ...(items.length ? items : [h('div', { class: 'toc-empty' }, '还没有标题')]))
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    return true
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode') }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode') }
  destroy() { tocViews.delete(this) }
  ignoreMutation() { return true }
  stopEvent(e: Event) { return e.type === 'mousedown' && !!(e.target as HTMLElement).closest('[data-pos]') }
}

// ------------------------------------------------------------------ raw inline html

class HtmlInlineView implements NodeView {
  dom: HTMLElement
  constructor(public node: PMNode) {
    this.dom = h('span', { class: 'html-inline' }, node.attrs.html)
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.dom.textContent = node.attrs.html
    this.node = node
    return true
  }
  ignoreMutation() { return true }
}

export const nodeViews = {
  code_block: (node: PMNode, view: EditorView, getPos: GetPos, decos: readonly Decoration[]) =>
    isPreviewBlock(node) ? new PreviewBlockView(node, view, getPos, decos) : new CodeBlockView(node, view, getPos),
  math_block: (node: PMNode, view: EditorView, getPos: GetPos, decos: readonly Decoration[]) => new PreviewBlockView(node, view, getPos, decos),
  html_block: (node: PMNode, view: EditorView, getPos: GetPos, decos: readonly Decoration[]) => new PreviewBlockView(node, view, getPos, decos),
  frontmatter: (node: PMNode, view: EditorView, getPos: GetPos, decos: readonly Decoration[]) => new PreviewBlockView(node, view, getPos, decos),
  math_inline: (node: PMNode) => new MathInlineView(node),
  image: (node: PMNode) => new ImageView(node),
  list_item: (node: PMNode, view: EditorView, getPos: GetPos) => new ListItemView(node, view, getPos),
  callout: (node: PMNode, view: EditorView, getPos: GetPos) => new CalloutView(node, view, getPos),
  footnote_def: (node: PMNode) => new FootnoteDefView(node),
  footnote_ref: (node: PMNode) => new FootnoteRefView(node),
  toc: (node: PMNode, view: EditorView) => new TocView(node, view),
  html_inline: (node: PMNode) => new HtmlInlineView(node),
}
