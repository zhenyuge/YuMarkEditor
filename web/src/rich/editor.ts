import type { Node as PMNode } from 'prosemirror-model'
import { EditorState, NodeSelection, Selection, TextSelection, type Transaction } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { undo, redo } from 'prosemirror-history'
import {
  addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, deleteTable, isInTable,
} from 'prosemirror-tables'
import { SearchQuery, findNext, findPrev, getSearchState, replaceAll, replaceNext, setSearchState } from 'prosemirror-search'
import { schema } from '../md/schema'
import { bridge } from '../bridge'
import { basePlugins } from './plugins'
import { nodeViews } from './nodeviews'
import { RichUI, slashPlugin } from './menus'
import * as C from './commands'

export interface FindQuery { search: string; replace: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean }

export class RichEditor {
  view: EditorView
  ui: RichUI
  private plugins
  onChange: (tr: Transaction) => void = () => {}
  onSelection: () => void = () => {}
  getEnv: () => any = () => ({})

  constructor(public mount: HTMLElement, public scroller: HTMLElement) {
    this.ui = new RichUI({ host: () => this.scroller })
    this.plugins = basePlugins({
      onLink: () => this.ui.openLinkEditor(),
      onFind: () => {},
      getEnv: () => this.getEnv(),
      extra: [slashPlugin(() => this.scroller), this.ui.plugin()],
    })
    this.view = new EditorView(mount, {
      state: this.createState(schema.nodes.doc.create(null, schema.nodes.paragraph.create())),
      nodeViews: nodeViews as any,
      attributes: { class: 'markdown-body', spellcheck: 'false' },
      dispatchTransaction: tr => {
        const state = this.view.state.apply(tr)
        this.view.updateState(state)
        if (tr.docChanged) this.onChange(tr)
        else if (tr.selectionSet) this.onSelection()
      },
      handleDOMEvents: {
        contextmenu: (view, e) => {
          const pos = view.posAtCoords({ left: e.clientX, top: e.clientY })
          if (!pos) return false
          const $p = view.state.doc.resolve(pos.pos)
          if (!C.findAncestor($p, n => n.type === schema.nodes.table)) return false
          e.preventDefault()
          if (!isInTable(view.state) || !view.state.selection.$from.sameParent($p) && !(view.state.selection as any).$anchorCell) {
            view.dispatch(view.state.tr.setSelection(TextSelection.near($p)))
          }
          this.tableMenu(e.clientX, e.clientY)
          return true
        },
      },
    })
  }

  createState(doc: PMNode, selection?: { anchor: number; head: number } | null): EditorState {
    let state = EditorState.create({ doc, plugins: this.plugins })
    if (selection) {
      try {
        const size = doc.content.size
        const sel = TextSelection.create(doc, Math.min(selection.anchor, size), Math.min(selection.head, size))
        state = state.apply(state.tr.setSelection(sel))
      } catch {}
    } else {
      // caret at the first ordinary text block (not inside frontmatter / code)
      let target = -1
      doc.descendants((n, pos) => {
        if (target >= 0) return false
        if (n.isTextblock && !n.type.spec.code) { target = pos + 1; return false }
        return !n.type.spec.code && !n.isAtom
      })
      state = state.apply(state.tr.setSelection(target >= 0 ? TextSelection.create(doc, target) : Selection.atStart(doc)))
    }
    return state
  }

  get state() { return this.view.state }

  setState(state: EditorState) {
    this.ui.hideAll()
    this.view.updateState(state)
  }

  focus() { this.view.focus() }

  run(cmd: (state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView) => boolean) {
    const ok = cmd(this.view.state, this.view.dispatch, this.view)
    this.view.focus()
    return ok
  }

  command(name: string, arg?: any): boolean {
    const map: Record<string, any> = {
      undo, redo,
      bold: C.toggleStrong, italic: C.toggleEm, strike: C.toggleStrike, code: C.toggleCode,
      heading: C.setHeading(arg ?? 0),
      quote: C.toggleBlockquote,
      ul: C.toggleList('bullet'), ol: C.toggleList('ordered'), task: C.toggleList('task'),
      codeblock: C.insertCodeBlock(''), mathblock: C.insertMathBlock, mathinline: C.insertMathInline,
      mermaid: C.insertCodeBlock('mermaid'), table: C.insertTable(3, 3), hr: C.insertHR, toc: C.insertTOC,
      footnote: C.insertFootnote, frontmatter: C.insertFrontmatter, callout: C.insertCallout(arg || 'NOTE'),
      html: C.insertHTMLBlock,
      moveUp: C.moveBlock(-1), moveDown: C.moveBlock(1),
    }
    if (name === 'link') { this.ui.openLinkEditor(); return true }
    const cmd = map[name]
    return cmd ? this.run(cmd) : false
  }

  async tableMenu(x: number, y: number) {
    const id = await bridge.menu([
      { id: 'rowBefore', title: '在上方插入行' },
      { id: 'rowAfter', title: '在下方插入行' },
      { id: 'colBefore', title: '在左侧插入列' },
      { id: 'colAfter', title: '在右侧插入列' },
      { separator: true },
      { id: 'alignLeft', title: '列左对齐' },
      { id: 'alignCenter', title: '列居中' },
      { id: 'alignRight', title: '列右对齐' },
      { id: 'alignNone', title: '取消列对齐' },
      { separator: true },
      { id: 'delRow', title: '删除行' },
      { id: 'delCol', title: '删除列' },
      { id: 'delTable', title: '删除表格' },
    ], x, y)
    if (!id) return
    const cmds: Record<string, any> = {
      rowBefore: addRowBefore, rowAfter: addRowAfter, colBefore: addColumnBefore, colAfter: addColumnAfter,
      alignLeft: C.setColumnAlign('left'), alignCenter: C.setColumnAlign('center'), alignRight: C.setColumnAlign('right'),
      alignNone: C.setColumnAlign(null), delRow: deleteRow, delCol: deleteColumn, delTable: deleteTable,
    }
    this.run(cmds[id])
  }

  // ------------------------------------------------------------ find & replace
  setQuery(q: FindQuery | null) {
    const query = new SearchQuery(q ? { ...q, literal: !q.regexp } : { search: '' })
    const cur = getSearchState(this.view.state)
    if (cur && cur.query.eq(query)) return
    this.view.dispatch(setSearchState(this.view.state.tr, query))
  }
  findNext() { return findNext(this.view.state, this.view.dispatch) }
  findPrev() { return findPrev(this.view.state, this.view.dispatch) }
  replaceNext() { return replaceNext(this.view.state, this.view.dispatch) }
  replaceAll() { return replaceAll(this.view.state, this.view.dispatch) }
  matchInfo(): { current: number; total: number } {
    const st = getSearchState(this.view.state)
    if (!st || !st.query.valid) return { current: 0, total: 0 }
    const state = this.view.state
    const sel = state.selection
    let total = 0, current = 0, pos = 0
    for (;;) {
      const m = st.query.findNext(state, pos)
      if (!m) break
      total++
      if (m.from === sel.from && m.to === sel.to) current = total
      pos = m.to > m.from ? m.to : m.to + 1
      if (total > 9999) break
    }
    return { current, total }
  }

  selectedText(): string {
    const { from, to } = this.view.state.selection
    return this.view.state.doc.textBetween(from, to, ' ')
  }

  /** index of the top-level block holding the caret, and a rough offset inside it */
  caretBlock(): { index: number; offset: number } {
    const { $head } = this.view.state.selection
    if ($head.depth === 0) return { index: $head.index(0), offset: 0 }
    const top = $head.node(1)
    const inner = top.textBetween(0, Math.max(0, $head.pos - $head.before(1) - 1), '\n', ' ')
    return { index: $head.index(0), offset: inner.length }
  }

  placeCaretAtBlock(index: number) {
    const doc = this.view.state.doc
    index = Math.max(0, Math.min(index, doc.childCount - 1))
    let pos = 0
    for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize
    const node = doc.child(index)
    let sel: Selection
    if (node.isAtom || (!node.isTextblock && node.type.spec.selectable !== false && !node.firstChild)) sel = NodeSelection.create(doc, pos)
    else sel = Selection.near(doc.resolve(pos + 1))
    this.view.dispatch(this.view.state.tr.setSelection(sel).scrollIntoView())
  }
}
