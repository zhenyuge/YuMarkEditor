import { EditorState, EditorSelection, type Extension, type Transaction } from '@codemirror/state'
import { EditorView, keymap, drawSelection, dropCursor, highlightActiveLine, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, moveLineDown, moveLineUp, undo, redo } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting, indentUnit, bracketMatching } from '@codemirror/language'
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown'
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, replaceAll, replaceNext,
  search, setSearchQuery, SearchCursor, RegExpCursor,
} from '@codemirror/search'
import { tags as t } from '@lezer/highlight'
import type { FindQuery } from '../rich/editor'

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', fontSize: '1.3em' },
  { tag: t.heading2, fontWeight: '700', fontSize: '1.18em' },
  { tag: t.heading3, fontWeight: '700', fontSize: '1.08em' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--link)' },
  { tag: t.url, color: 'var(--muted)', textDecoration: 'underline' },
  { tag: t.monospace, color: 'var(--code-fg)', fontFamily: 'var(--mono)' },
  { tag: [t.processingInstruction, t.contentSeparator, t.labelName], color: 'var(--syntax)' },
  { tag: t.quote, color: 'var(--muted)' },
  { tag: t.list, color: 'var(--text)' },
  { tag: [t.meta, t.comment], color: 'var(--muted)' },
  { tag: [t.angleBracket, t.tagName, t.attributeName], color: 'var(--syntax)' },
])

const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text)', fontSize: 'var(--source-size)' },
  '.cm-content': { fontFamily: 'var(--mono)', lineHeight: '1.7', padding: '0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-searchMatch': { backgroundColor: 'var(--find)', borderRadius: '2px' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--find-active)' },
  '.cm-panels': { display: 'none' },
  '.cm-placeholder': { color: 'var(--faint)' },
  '.cm-scroller': { overflow: 'visible', fontFamily: 'var(--mono)' },
})

/** wrap / unwrap the selection with a markdown marker */
function wrapWith(marker: string, close = marker) {
  return (view: EditorView) => {
    const changes = view.state.changeByRange(range => {
      const text = view.state.sliceDoc(range.from, range.to)
      const before = view.state.sliceDoc(range.from - marker.length, range.from)
      const after = view.state.sliceDoc(range.to, range.to + close.length)
      if (before === marker && after === close) {
        return {
          changes: [{ from: range.from - marker.length, to: range.from }, { from: range.to, to: range.to + close.length }],
          range: EditorSelection.range(range.from - marker.length, range.to - marker.length),
        }
      }
      if (text.startsWith(marker) && text.endsWith(close) && text.length >= marker.length + close.length) {
        return {
          changes: { from: range.from, to: range.to, insert: text.slice(marker.length, text.length - close.length) },
          range: EditorSelection.range(range.from, range.to - marker.length - close.length),
        }
      }
      return {
        changes: [{ from: range.from, insert: marker }, { from: range.to, insert: close }],
        range: EditorSelection.range(range.from + marker.length, range.to + marker.length),
      }
    })
    view.dispatch(view.state.update(changes, { scrollIntoView: true, userEvent: 'input' }))
    return true
  }
}

/** set a line prefix (heading / quote / list) for all selected lines */
function linePrefix(make: (line: string, i: number) => string) {
  return (view: EditorView) => {
    const { state } = view
    const changes: { from: number; to: number; insert: string }[] = []
    const seen = new Set<number>()
    let i = 0
    for (const r of state.selection.ranges) {
      for (let pos = r.from; pos <= r.to;) {
        const line = state.doc.lineAt(pos)
        if (!seen.has(line.number)) {
          seen.add(line.number)
          const next = make(line.text, i++)
          if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next })
        }
        pos = line.to + 1
      }
    }
    view.dispatch({ changes, userEvent: 'input' })
    return true
  }
}

const stripPrefix = (s: string) => s.replace(/^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/, '$1')

export const sourceCommands: Record<string, (view: EditorView, arg?: any) => boolean> = {
  undo: v => undo(v), redo: v => redo(v),
  bold: wrapWith('**'), italic: wrapWith('*'), strike: wrapWith('~~'), code: wrapWith('`'), mathinline: wrapWith('$'),
  link: v => {
    const r = v.state.selection.main
    const text = v.state.sliceDoc(r.from, r.to)
    const insert = `[${text}]()`
    v.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: { anchor: r.from + insert.length - 1 }, userEvent: 'input' })
    return true
  },
  heading: (v, level = 0) => linePrefix(l => {
    const m = /^(#{1,6})\s+/.exec(l)
    const body = l.replace(/^#{1,6}\s+/, '')
    if (!level || (m && m[1].length === level)) return body
    return '#'.repeat(level) + ' ' + body
  })(v),
  quote: linePrefix(l => (/^>\s?/.test(l) ? l.replace(/^>\s?/, '') : '> ' + l)),
  ul: linePrefix(l => (/^\s*[-*+]\s+(?!\[)/.test(l) ? stripPrefix(l) : '- ' + stripPrefix(l))),
  ol: linePrefix((l, i) => (/^\s*\d+[.)]\s+/.test(l) ? stripPrefix(l) : `${i + 1}. ` + stripPrefix(l))),
  task: linePrefix(l => (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(l) ? stripPrefix(l) : '- [ ] ' + stripPrefix(l))),
  codeblock: v => insertBlock(v, '```\n', '\n```'),
  mathblock: v => insertBlock(v, '$$\n', '\n$$'),
  mermaid: v => insertBlock(v, '```mermaid\ngraph TD\n  A --> B', '\n```'),
  table: v => insertBlock(v, '| 列 1 | 列 2 | 列 3 |\n| ---- | ---- | ---- |\n| ', ' |      |      |'),
  hr: v => insertBlock(v, '---', ''),
  toc: v => insertBlock(v, '[TOC]', ''),
  callout: v => insertBlock(v, '> [!NOTE]\n> ', ''),
  footnote: v => {
    const text = v.state.doc.toString()
    let n = 1
    while (text.includes(`[^${n}]`)) n++
    const r = v.state.selection.main
    const def = `\n\n[^${n}]: `
    v.dispatch({
      changes: [{ from: r.to, insert: `[^${n}]` }, { from: v.state.doc.length, insert: def }],
      selection: { anchor: v.state.doc.length + `[^${n}]`.length + def.length },
      scrollIntoView: true,
    })
    return true
  },
  frontmatter: v => {
    if (v.state.doc.toString().startsWith('---\n')) return true
    v.dispatch({ changes: { from: 0, insert: '---\ntitle: \n---\n\n' }, selection: { anchor: 11 } })
    return true
  },
  html: v => insertBlock(v, '<div>\n', '\n</div>'),
  moveUp: v => moveLineUp(v), moveDown: v => moveLineDown(v),
}

function insertBlock(view: EditorView, before: string, after: string) {
  const { state } = view
  const r = state.selection.main
  const line = state.doc.lineAt(r.from)
  const sel = state.sliceDoc(r.from, r.to)
  const lead = line.text.trim() && r.from === line.from ? '' : line.text.trim() ? '\n\n' : ''
  const insert = lead + before + sel + after
  view.dispatch({
    changes: { from: r.from, to: r.to, insert },
    selection: { anchor: r.from + lead.length + before.length + sel.length },
    scrollIntoView: true,
    userEvent: 'input',
  })
  return true
}

export class SourceEditor {
  view: EditorView
  onChange: (tr: Transaction) => void = () => {}
  extensions: Extension[]

  constructor(mount: HTMLElement) {
    this.extensions = [
      history(),
      drawSelection(),
      dropCursor(),
      highlightActiveLine(),
      bracketMatching(),
      indentUnit.of('    '),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(mdHighlight),
      search({ createPanel: () => ({ dom: document.createElement('div') }) }),
      placeholder('Markdown 源码'),
      keymap.of([
        { key: 'Alt-ArrowUp', run: moveLineUp },
        { key: 'Alt-ArrowDown', run: moveLineDown },
        { key: 'Mod-b', run: sourceCommands.bold },
        { key: 'Mod-i', run: sourceCommands.italic },
        { key: 'Mod-Shift-x', run: sourceCommands.strike },
        { key: 'Ctrl-`', run: sourceCommands.code },
        { key: 'Mod-k', run: sourceCommands.link },
        ...markdownKeymap,
        indentWithTab,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      theme,
      EditorView.updateListener.of(u => {
        for (const tr of u.transactions) if (tr.docChanged) { this.onChange(tr); break }
      }),
      EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
    ]
    this.view = new EditorView({ parent: mount, state: this.createState('') })
  }

  createState(text: string, cursor?: number): EditorState {
    return EditorState.create({
      doc: text,
      extensions: this.extensions,
      selection: cursor != null ? { anchor: Math.min(cursor, text.length) } : undefined,
    })
  }

  get state() { return this.view.state }
  setState(state: EditorState) { this.view.setState(state) }
  scrollToCursor() {
    this.view.dispatch({ effects: EditorView.scrollIntoView(this.view.state.selection.main.head, { y: 'center' }) })
  }
  text() { return this.view.state.doc.toString() }
  focus() { this.view.focus() }

  command(name: string, arg?: any) {
    const c = sourceCommands[name]
    if (!c) return false
    const ok = c(this.view, arg)
    this.view.focus()
    return ok
  }

  // ------------------------------------------------------------ find & replace
  setQuery(q: FindQuery | null) {
    if (!q || !q.search) {
      this.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) })
      closeSearchPanel(this.view)
      return
    }
    const query = new SearchQuery({ search: q.search, replace: q.replace, caseSensitive: q.caseSensitive, regexp: q.regexp, wholeWord: q.wholeWord, literal: !q.regexp })
    if (!getSearchQuery(this.view.state).eq(query)) this.view.dispatch({ effects: setSearchQuery.of(query) })
    const active = document.activeElement as HTMLElement | null
    openSearchPanel(this.view)
    if (active && active !== document.activeElement) active.focus()
  }
  findNext() { return findNext(this.view) }
  findPrev() { return findPrevious(this.view) }
  replaceNext() { return replaceNext(this.view) }
  replaceAll() { return replaceAll(this.view) }
  matchInfo() {
    const q = getSearchQuery(this.view.state)
    if (!q.search || !q.valid) return { current: 0, total: 0 }
    const sel = this.view.state.selection.main
    let total = 0, current = 0
    const doc = this.view.state.doc
    let cursor: any
    if (q.regexp) cursor = new RegExpCursor(doc, q.search, { ignoreCase: !q.caseSensitive })
    else cursor = new SearchCursor(doc, q.search, 0, doc.length, q.caseSensitive ? undefined : (x: string) => x.toLowerCase())
    for (let r = cursor.next(); !r.done; r = cursor.next()) {
      total++
      if (r.value.from === sel.from && r.value.to === sel.to) current = total
      if (total > 9999) break
    }
    return { current, total }
  }
  selectedText() {
    const r = this.view.state.selection.main
    return this.view.state.sliceDoc(r.from, r.to)
  }
}
