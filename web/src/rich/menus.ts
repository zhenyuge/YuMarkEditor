import { type Command, NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { schema } from '../md/schema'
import { icons, CALLOUT_LABEL } from '../icons'
import { renderMathInto } from '../render'
import { h } from '../util'
import {
  insertCallout, insertCodeBlock, insertFootnote, insertFrontmatter, insertHR, insertHTMLBlock, insertMathBlock,
  insertMathInline, insertTable, insertTOC, markActive, markRange, setHeading, setLink, toggleBlockquote,
  toggleCode, toggleEm, toggleList, toggleStrike, toggleStrong,
} from './commands'
import { editorCtx } from './context'

const S = schema.nodes
const M = schema.marks

/** Absolutely positioned floating element living inside the editor's scroller. */
class Floating {
  el: HTMLElement
  constructor(public host: HTMLElement, cls: string) {
    this.el = h('div', { class: 'floating ' + cls })
    this.el.style.display = 'none'
    host.append(this.el)
  }
  get visible() { return this.el.style.display !== 'none' }
  show(anchor: { left: number; right: number; top: number; bottom: number }, place: 'above' | 'below' = 'below', align: 'start' | 'center' = 'start') {
    const hostRect = this.host.getBoundingClientRect()
    this.el.style.display = ''
    this.el.style.visibility = 'hidden'
    const w = this.el.offsetWidth, hgt = this.el.offsetHeight
    let left = (align === 'center' ? (anchor.left + anchor.right) / 2 - w / 2 : anchor.left) - hostRect.left + this.host.scrollLeft
    left = Math.max(8, Math.min(left, this.host.clientWidth - w - 8))
    let top = place === 'above' ? anchor.top - hostRect.top + this.host.scrollTop - hgt - 8 : anchor.bottom - hostRect.top + this.host.scrollTop + 6
    if (place === 'above' && anchor.top - hgt - 8 < hostRect.top) top = anchor.bottom - hostRect.top + this.host.scrollTop + 8
    this.el.style.left = left + 'px'
    this.el.style.top = top + 'px'
    this.el.style.visibility = ''
  }
  hide() { this.el.style.display = 'none' }
}

// ------------------------------------------------------------------ slash menu

interface SlashItem { id: string; title: string; hint?: string; keys: string; icon: string; run?: Command; action?: (view: EditorView) => void }

const SLASH_ITEMS: SlashItem[] = [
  { id: 'p', title: '正文', keys: 'text paragraph zw zhengwen', icon: icons.paragraph, run: setHeading(0) },
  { id: 'h1', title: '一级标题', hint: '#', keys: 'h1 heading bt biaoti yiji', icon: icons.h1, run: setHeading(1) },
  { id: 'h2', title: '二级标题', hint: '##', keys: 'h2 heading bt biaoti erji', icon: icons.h2, run: setHeading(2) },
  { id: 'h3', title: '三级标题', hint: '###', keys: 'h3 heading bt biaoti sanji', icon: icons.h3, run: setHeading(3) },
  { id: 'ul', title: '无序列表', hint: '-', keys: 'ul bullet list lb liebiao wuxu', icon: icons.ul, run: toggleList('bullet') },
  { id: 'ol', title: '有序列表', hint: '1.', keys: 'ol ordered number list lb liebiao youxu', icon: icons.ol, run: toggleList('ordered') },
  { id: 'task', title: '任务列表', hint: '[ ]', keys: 'task todo check rw renwu daiban', icon: icons.task, run: toggleList('task') },
  { id: 'quote', title: '引用', hint: '>', keys: 'quote blockquote yy yinyong', icon: icons.quote, run: toggleBlockquote },
  { id: 'callout', title: '提示块', hint: '[!NOTE]', keys: 'callout note tip warning admonition ts tishi', icon: icons.callout, run: insertCallout('NOTE') },
  { id: 'code', title: '代码块', hint: '```', keys: 'code codeblock dm daima', icon: icons.codeblock, run: insertCodeBlock('') },
  { id: 'math', title: '公式块', hint: '$$', keys: 'math latex katex equation gs gongshi', icon: icons.sigma, run: insertMathBlock },
  { id: 'imath', title: '行内公式', hint: '$', keys: 'inline math latex hngs hangnei gongshi', icon: icons.math, run: insertMathInline },
  { id: 'mermaid', title: 'Mermaid 图表', keys: 'mermaid diagram flowchart chart tb tubiao liucheng', icon: icons.chart, run: insertCodeBlock('mermaid') },
  { id: 'table', title: '表格', hint: '|', keys: 'table bg biaoge', icon: icons.table, run: insertTable(3, 3) },
  { id: 'image', title: '图片', keys: 'image picture photo tp tupian', icon: icons.image, action: () => editorCtx.pickImages() },
  { id: 'hr', title: '分割线', hint: '---', keys: 'hr divider rule line fgx fengexian', icon: icons.hr, run: insertHR },
  { id: 'toc', title: '目录', hint: '[TOC]', keys: 'toc contents ml mulu', icon: icons.toc, run: insertTOC },
  { id: 'fn', title: '脚注', hint: '[^1]', keys: 'footnote jz jiaozhu', icon: icons.footnote, run: insertFootnote },
  { id: 'props', title: '属性', hint: 'YAML', keys: 'frontmatter properties yaml meta sx shuxing', icon: icons.props, run: insertFrontmatter },
  { id: 'html', title: 'HTML / SVG', keys: 'html svg raw', icon: icons.html, run: insertHTMLBlock },
]

const slashKey = new PluginKey<SlashState>('slash')
interface SlashState { active: boolean; from: number; query: string }

function filterItems(q: string) {
  q = q.toLowerCase().trim()
  if (!q) return SLASH_ITEMS
  return SLASH_ITEMS.filter(it => it.title.toLowerCase().includes(q) || it.keys.split(' ').some(k => k.startsWith(q)) || it.id === q)
}

export function slashPlugin(host: () => HTMLElement) {
  let menu: Floating | null = null
  let index = 0
  let items: SlashItem[] = []

  const close = (view: EditorView) => {
    if (slashKey.getState(view.state)?.active) view.dispatch(view.state.tr.setMeta(slashKey, { close: true }))
  }

  const choose = (view: EditorView, item: SlashItem) => {
    const st = slashKey.getState(view.state)!
    const tr = view.state.tr.delete(st.from, view.state.selection.from).setMeta(slashKey, { close: true })
    view.dispatch(tr)
    if (item.action) item.action(view)
    else item.run!(view.state, view.dispatch, view)
    view.focus()
  }

  const render = (view: EditorView) => {
    const st = slashKey.getState(view.state)!
    if (!menu) menu = new Floating(host(), 'slash-menu')
    if (!st.active) { menu.hide(); return }
    items = filterItems(st.query)
    if (!items.length) { menu.hide(); return }
    index = Math.min(index, items.length - 1)
    menu.el.replaceChildren(...items.map((it, i) => {
      const row = h('div', { class: 'slash-item' + (i === index ? ' active' : '') },
        h('span', { class: 'slash-icon', html: it.icon }),
        h('span', { class: 'slash-title' }, it.title),
        it.hint ? h('span', { class: 'slash-hint' }, it.hint) : null)
      row.addEventListener('mousedown', e => { e.preventDefault(); choose(view, it) })
      row.addEventListener('mousemove', () => {
        if (index !== i) { index = i; render(view) }
      })
      return row
    }))
    const c = view.coordsAtPos(st.from)
    menu.show(c, 'below')
    const active = menu.el.querySelector('.active') as HTMLElement | null
    active?.scrollIntoView({ block: 'nearest' })
  }

  return new Plugin<SlashState>({
    key: slashKey,
    state: {
      init: () => ({ active: false, from: 0, query: '' }),
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(slashKey)
        if (meta?.close) return { active: false, from: 0, query: '' }
        if (meta?.open != null) return { active: true, from: meta.open, query: '' }
        if (!prev.active) return prev
        const from = tr.mapping.map(prev.from)
        const sel = state.selection
        if (!sel.empty || sel.from <= from || sel.$from.parent !== state.doc.resolve(from).parent) return { active: false, from: 0, query: '' }
        const text = state.doc.textBetween(from, sel.from, '\n', '￼')
        if (!/^[/、]/.test(text) || /[\s￼]/.test(text.slice(1)) || text.length > 24) return { active: false, from: 0, query: '' }
        return { active: true, from, query: text.slice(1) }
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        // "、" is what the "/" key types with a Chinese input method
        if (text !== '/' && text !== '、') return false
        const $from = view.state.doc.resolve(from)
        if ($from.parent.type.spec.code || !$from.parent.isTextblock) return false
        if ($from.parent.type === S.table_cell || $from.parent.type === S.table_header) return false
        const before = $from.parent.textBetween(0, $from.parentOffset, '\n', '￼')
        if (before.trim() !== '' || from !== to) return false
        index = 0
        view.dispatch(view.state.tr.insertText(text, from, to).setMeta(slashKey, { open: from }))
        return true
      },
      handleKeyDown(view, e) {
        const st = slashKey.getState(view.state)
        if (!st?.active || !items.length) return false
        if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { index = (index + 1) % items.length; render(view); return true }
        if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { index = (index - 1 + items.length) % items.length; render(view); return true }
        if (e.key === 'Enter' || e.key === 'Tab') { choose(view, items[index]); return true }
        if (e.key === 'Escape') { close(view); return true }
        return false
      },
      handleDOMEvents: {
        blur(view) { setTimeout(() => { if (!view.hasFocus()) close(view) }, 150); return false },
      },
    },
    view(view) {
      return {
        update(v, prevState) {
          const a = slashKey.getState(v.state), b = slashKey.getState(prevState)
          if (a !== b) {
            if (a && b && a.query !== b.query) index = 0
            render(v)
          }
        },
        destroy() { menu?.el.remove(); menu = null },
      }
      void view
    },
  })
}

// ------------------------------------------------------------------ bubble toolbar & popovers

interface UIOpts {
  host: () => HTMLElement
}

export class RichUI {
  bubble: Floating | null = null
  linkTip: Floating | null = null
  pop: Floating | null = null
  popKind: string | null = null
  mouseDown = false
  view!: EditorView

  constructor(public opts: UIOpts) {}

  plugin() {
    const self = this
    return new Plugin({
      view(view) {
        self.view = view
        const onDown = () => { self.mouseDown = true; self.bubble?.hide() }
        const onUp = () => { if (self.mouseDown) { self.mouseDown = false; setTimeout(() => self.update(), 0) } }
        view.dom.addEventListener('mousedown', onDown)
        document.addEventListener('mouseup', onUp)
        return {
          update: () => self.update(),
          destroy() {
            view.dom.removeEventListener('mousedown', onDown)
            document.removeEventListener('mouseup', onUp)
          },
        }
      },
      props: {
        handleKeyDown(_view, e) {
          if (e.key === 'Escape' && (self.bubble?.visible || self.pop?.visible)) {
            self.hideAll()
            return true
          }
          return false
        },
        handleDOMEvents: {
          blur() {
            setTimeout(() => {
              const active = document.activeElement
              const inUI = [self.bubble, self.pop, self.linkTip].some(f => f && f.el.contains(active))
              if (!inUI && !self.view.hasFocus()) { self.bubble?.hide(); self.linkTip?.hide() }
            }, 100)
            return false
          },
        },
      },
    })
  }

  ensure() {
    const host = this.opts.host()
    if (!this.bubble || this.bubble.host !== host) {
      this.bubble?.el.remove(); this.linkTip?.el.remove(); this.pop?.el.remove()
      this.bubble = new Floating(host, 'bubble')
      this.linkTip = new Floating(host, 'link-tip')
      this.pop = new Floating(host, 'popover')
    }
  }

  hideAll() {
    this.bubble?.hide(); this.linkTip?.hide(); this.closePop()
  }

  closePop() {
    this.pop?.hide()
    this.popKind = null
  }

  update() {
    if (!this.view) return
    this.ensure()
    const { state } = this.view
    const sel = state.selection
    // node popovers
    if (sel instanceof NodeSelection) {
      this.bubble!.hide(); this.linkTip!.hide()
      const n = sel.node
      if (n.type === S.math_inline) return this.mathPopover(sel.from)
      if (n.type === S.image) return this.imagePopover(sel.from)
      if (n.type === S.callout) return this.calloutPopover(sel.from)
      this.closePop()
      return
    }
    if (this.popKind && this.popKind !== 'link') this.closePop()
    if (this.popKind === 'link') return
    if (!sel.empty && sel instanceof TextSelection && !this.mouseDown && this.view.hasFocus() && !sel.$from.parent.type.spec.code) {
      this.showBubble()
      this.linkTip!.hide()
      return
    }
    this.bubble!.hide()
    if (sel.empty && this.view.hasFocus()) {
      const link = M.link.isInSet(sel.$from.marks())
      if (link && sel.$from.parentOffset > 0) return this.showLinkTip(link.attrs.href)
    }
    this.linkTip!.hide()
  }

  showBubble() {
    const view = this.view
    const { from, to } = view.state.selection
    const btn = (icon: string, title: string, cmd: Command, active = false) => {
      const b = h('button', { class: 'bb' + (active ? ' on' : ''), title, html: icon })
      b.addEventListener('mousedown', e => { e.preventDefault(); cmd(view.state, view.dispatch, view); view.focus() })
      return b
    }
    const st = view.state
    const parent = st.selection.$from.parent
    const lvl = parent.type === S.heading ? parent.attrs.level : 0
    this.bubble!.el.replaceChildren(
      btn(icons.bold, '粗体 ⌘B', toggleStrong, markActive(st, M.strong)),
      btn(icons.italic, '斜体 ⌘I', toggleEm, markActive(st, M.em)),
      btn(icons.strike, '删除线 ⇧⌘X', toggleStrike, markActive(st, M.strike)),
      btn(icons.code, '行内代码 ⌃`', toggleCode, markActive(st, M.code)),
      btn(icons.link, '链接 ⌘K', () => { this.openLinkEditor(); return true }, markActive(st, M.link)),
      btn(icons.math, '行内公式 ⌃M', insertMathInline),
      h('span', { class: 'bb-sep' }),
      btn(icons.h1, '一级标题', setHeading(1), lvl === 1),
      btn(icons.h2, '二级标题', setHeading(2), lvl === 2),
      btn(icons.h3, '三级标题', setHeading(3), lvl === 3),
      btn(icons.quote, '引用', toggleBlockquote),
    )
    const a = view.coordsAtPos(from), b = view.coordsAtPos(to, -1)
    const rect = { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) }
    if (a.top !== b.top) { rect.left = a.left; rect.right = a.left + 40 }
    this.bubble!.show(rect, 'above', 'center')
  }

  showLinkTip(href: string) {
    const view = this.view
    const open = h('button', { class: 'lt-btn', title: '打开 (⌘点击)', html: icons.external })
    open.addEventListener('mousedown', e => { e.preventDefault(); editorCtx.openLink(href) })
    const edit = h('button', { class: 'lt-btn', title: '编辑链接', html: icons.edit })
    edit.addEventListener('mousedown', e => { e.preventDefault(); this.openLinkEditor() })
    const remove = h('button', { class: 'lt-btn', title: '移除链接', html: icons.close })
    remove.addEventListener('mousedown', e => { e.preventDefault(); setLink(null)(view.state, view.dispatch); view.focus() })
    this.linkTip!.el.replaceChildren(h('span', { class: 'lt-url', title: href }, href || '（空链接）'), open, edit, remove)
    const range = markRange(view.state.selection.$from, M.link)
    const c = view.coordsAtPos(range ? range.from : view.state.selection.from)
    this.linkTip!.show(c, 'below')
  }

  openLinkEditor() {
    const view = this.view
    this.ensure()
    const { $from, empty, from, to } = view.state.selection
    const existing = M.link.isInSet($from.marks()) || (empty ? null : findLinkIn(view.state, from, to))
    const range = empty ? markRange($from, M.link) : null
    const needText = empty && !range
    const url = h('input', { class: 'pop-input', placeholder: '链接地址（网址、文件路径或 #标题）', value: existing?.attrs.href || '', spellcheck: 'false' }) as HTMLInputElement
    const text = needText ? h('input', { class: 'pop-input', placeholder: '显示文字（可选）' }) as HTMLInputElement : null
    const ok = h('button', { class: 'pop-btn primary' }, '确定')
    const commit = () => {
      const href = url.value.trim()
      this.closePop()
      setLink(href || null, text?.value || undefined)(view.state, view.dispatch)
      view.focus()
    }
    ok.addEventListener('click', commit)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); commit() }
      if (e.key === 'Escape') { e.preventDefault(); this.closePop(); view.focus() }
    }
    url.addEventListener('keydown', onKey)
    text?.addEventListener('keydown', onKey)
    this.pop!.el.replaceChildren(h('div', { class: 'pop-row' }, url), text ? h('div', { class: 'pop-row' }, text) : '', h('div', { class: 'pop-actions' }, ok))
    this.popKind = 'link'
    this.bubble!.hide(); this.linkTip!.hide()
    const c = view.coordsAtPos(range ? range.from : from)
    this.pop!.show(c, 'below')
    url.focus()
    url.select()
  }

  mathPopover(pos: number) {
    const view = this.view
    if (this.popKind === 'math:' + pos) return
    const node = view.state.doc.nodeAt(pos)!
    const ta = h('textarea', { class: 'pop-code', spellcheck: 'false', rows: '1', placeholder: 'LaTeX，例如 E=mc^2' }) as HTMLTextAreaElement
    ta.value = node.attrs.tex
    const preview = h('div', { class: 'pop-math-preview' })
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(200, ta.scrollHeight) + 'px' }
    const sync = () => {
      renderMathInto(preview, ta.value || '\\,', false)
      const cur = view.state.doc.nodeAt(pos)
      if (cur && cur.type === S.math_inline && cur.attrs.tex !== ta.value) {
        const tr = view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, tex: ta.value })
        tr.setSelection(NodeSelection.create(tr.doc, pos))
        this.popKind = 'math:' + pos
        view.dispatch(tr)
      }
    }
    const finish = () => {
      const cur = view.state.doc.nodeAt(pos)
      this.closePop()
      if (!cur) return view.focus()
      let tr = view.state.tr
      if (!cur.attrs.tex.trim()) tr = tr.delete(pos, pos + cur.nodeSize)
      else tr = tr.setSelection(TextSelection.create(tr.doc, pos + cur.nodeSize))
      view.dispatch(tr)
      view.focus()
    }
    ta.addEventListener('input', () => { grow(); sync() })
    ta.addEventListener('keydown', e => {
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') { e.preventDefault(); finish() }
    })
    ta.addEventListener('blur', () => setTimeout(() => { if (this.popKind === 'math:' + pos && !this.pop!.el.contains(document.activeElement)) { this.closePop() } }, 100))
    this.pop!.el.replaceChildren(h('div', { class: 'pop-label' }, '行内公式'), ta, preview, h('div', { class: 'pop-tip' }, '回车完成 · ⇧回车换行'))
    this.popKind = 'math:' + pos
    const dom = view.nodeDOM(pos) as HTMLElement
    this.pop!.show(dom.getBoundingClientRect(), 'below')
    renderMathInto(preview, ta.value || '\\,', false)
    grow()
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
  }

  imagePopover(pos: number) {
    const view = this.view
    if (this.popKind === 'image:' + pos) return
    const node = view.state.doc.nodeAt(pos)!
    const src = h('input', { class: 'pop-input', value: node.attrs.src, placeholder: '图片地址', spellcheck: 'false' }) as HTMLInputElement
    const alt = h('input', { class: 'pop-input', value: node.attrs.alt, placeholder: '替代文字' }) as HTMLInputElement
    const apply = () => {
      const cur = view.state.doc.nodeAt(pos)
      if (!cur || cur.type !== S.image) return
      if (cur.attrs.src === src.value && cur.attrs.alt === alt.value) return
      const tr = view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, src: src.value.trim(), alt: alt.value })
      tr.setSelection(NodeSelection.create(tr.doc, pos))
      view.dispatch(tr)
    }
    for (const inp of [src, alt]) {
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); apply(); this.closePop(); view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1))); view.focus() }
        if (e.key === 'Escape') { e.preventDefault(); this.closePop(); view.focus() }
      })
      inp.addEventListener('change', apply)
    }
    this.pop!.el.replaceChildren(
      h('div', { class: 'pop-label' }, '图片'),
      h('div', { class: 'pop-row' }, src),
      h('div', { class: 'pop-row' }, alt),
    )
    this.popKind = 'image:' + pos
    const dom = view.nodeDOM(pos) as HTMLElement
    this.pop!.show(dom.getBoundingClientRect(), 'below')
  }

  calloutPopover(pos: number) {
    const view = this.view
    if (this.popKind === 'callout:' + pos) return
    const node = view.state.doc.nodeAt(pos)!
    const kinds = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION', 'INFO', 'SUCCESS', 'QUESTION', 'DANGER', 'BUG', 'EXAMPLE', 'QUOTE', 'ABSTRACT', 'TODO']
    const sel = h('select', { class: 'pop-select' }) as HTMLSelectElement
    const cur = node.attrs.kind as string
    if (!kinds.includes(cur.toUpperCase())) kinds.unshift(cur)
    for (const k of kinds) {
      const o = h('option', { value: k }, `${CALLOUT_LABEL[k.toLowerCase()] || k} · ${k}`)
      if (k.toUpperCase() === cur.toUpperCase()) o.selected = true
      sel.append(o)
    }
    const title = h('input', { class: 'pop-input', value: node.attrs.title, placeholder: '标题（可选）' }) as HTMLInputElement
    const fold = h('select', { class: 'pop-select' }) as HTMLSelectElement
    for (const [v, t] of [['', '不折叠'], ['+', '可折叠（展开）'], ['-', '可折叠（收起）']]) {
      const o = h('option', { value: v }, t)
      if (node.attrs.fold === v) o.selected = true
      fold.append(o)
    }
    const apply = () => {
      const n = view.state.doc.nodeAt(pos)
      if (!n || n.type !== S.callout) return
      const keepCase = n.attrs.kind.toUpperCase() === sel.value.toUpperCase() ? n.attrs.kind : sel.value
      const tr = view.state.tr.setNodeMarkup(pos, undefined, { kind: keepCase, title: title.value.trim(), fold: fold.value })
      tr.setSelection(NodeSelection.create(tr.doc, pos))
      view.dispatch(tr)
    }
    sel.addEventListener('change', apply)
    fold.addEventListener('change', apply)
    title.addEventListener('change', apply)
    title.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault(); apply(); this.closePop()
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 2)))
        view.focus()
      }
    })
    this.pop!.el.replaceChildren(h('div', { class: 'pop-label' }, '提示块'), h('div', { class: 'pop-row' }, sel, fold), h('div', { class: 'pop-row' }, title))
    this.popKind = 'callout:' + pos
    const dom = view.nodeDOM(pos) as HTMLElement
    const r = dom.getBoundingClientRect()
    this.pop!.show({ left: r.left, right: r.right, top: r.top, bottom: r.top + 34 }, 'below')
  }
}

function findLinkIn(state: EditorState, from: number, to: number) {
  let found: any = null
  state.doc.nodesBetween(from, to, n => { if (!found) found = M.link.isInSet(n.marks) })
  return found
}
