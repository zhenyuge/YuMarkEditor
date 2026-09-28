import { Fragment, type Node as PMNode, type NodeType, type ResolvedPos } from 'prosemirror-model'
import { type Command, EditorState, NodeSelection, Selection, TextSelection, type Transaction } from 'prosemirror-state'
import { lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands'
import { liftListItem, sinkListItem, wrapInList } from 'prosemirror-schema-list'
import { addRowAfter, isInTable, selectedRect, TableMap } from 'prosemirror-tables'
import { codeLang, schema } from '../md/schema'

const S = schema.nodes
const M = schema.marks

export const toggleStrong = toggleMark(M.strong)
export const toggleEm = toggleMark(M.em)
export const toggleStrike = toggleMark(M.strike)
export const toggleCode = toggleMark(M.code)

export function markActive(state: EditorState, type = M.strong): boolean {
  const { from, $from, to, empty } = state.selection
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks())
  return state.doc.rangeHasMark(from, to, type)
}

export function findAncestor($pos: ResolvedPos, pred: (n: PMNode) => boolean): { node: PMNode; depth: number; pos: number } | null {
  for (let d = $pos.depth; d > 0; d--) {
    const n = $pos.node(d)
    if (pred(n)) return { node: n, depth: d, pos: $pos.before(d) }
  }
  return null
}

export function setHeading(level: number): Command {
  return (state, dispatch) => {
    const { $from } = state.selection
    const cur = $from.parent
    if (level === 0 || (cur.type === S.heading && cur.attrs.level === level)) {
      return setBlockType(S.paragraph)(state, dispatch)
    }
    return setBlockType(S.heading, { level })(state, dispatch)
  }
}

export const toggleBlockquote: Command = (state, dispatch) => {
  const q = findAncestor(state.selection.$from, n => n.type === S.blockquote || n.type === S.callout)
  if (q) return lift(state, dispatch)
  return wrapIn(S.blockquote)(state, dispatch)
}

function listOf($pos: ResolvedPos) {
  return findAncestor($pos, n => n.type === S.bullet_list || n.type === S.ordered_list)
}

export function toggleList(kind: 'bullet' | 'ordered' | 'task'): Command {
  return (state, dispatch) => {
    const { $from } = state.selection
    const list = listOf($from)
    const wantType = kind === 'ordered' ? S.ordered_list : S.bullet_list
    if (list) {
      const isTask = firstItemChecked(list.node) != null
      const same = list.node.type === wantType && (kind === 'task') === isTask
      if (same) return liftListItem(S.list_item)(state, dispatch)
      if (dispatch) {
        const tr = state.tr
        if (list.node.type !== wantType) {
          tr.setNodeMarkup(list.pos, wantType, wantType === S.ordered_list ? { order: 1, tight: list.node.attrs.tight } : { tight: list.node.attrs.tight })
        }
        list.node.forEach((item, off) => {
          const checked = kind === 'task' ? (item.attrs.checked ?? false) : null
          tr.setNodeMarkup(list.pos + 1 + off, undefined, { ...item.attrs, checked })
        })
        dispatch(tr)
      }
      return true
    }
    if (!wrapInList(wantType)(state)) return false
    if (dispatch) {
      wrapInList(wantType)(state, tr => {
        if (kind === 'task') {
          const $pos = tr.doc.resolve(tr.mapping.map(state.selection.from))
          const l = listOf($pos)
          if (l) l.node.forEach((item, off) => { tr.setNodeMarkup(l.pos + 1 + off, undefined, { ...item.attrs, checked: false }) })
        }
        dispatch(tr)
      })
    }
    return true
  }
}

function firstItemChecked(list: PMNode) {
  return list.firstChild?.attrs.checked ?? null
}

/** Replace the current (empty-ish) textblock with `node`, or insert it after. */
export function insertBlock(node: PMNode, opts: { select?: 'inside' | 'after' } = {}): Command {
  return (state, dispatch) => {
    const { $from } = state.selection
    if (!dispatch) return true
    const tr = state.tr
    let pos: number
    const parent = $from.parent
    const depth = $from.depth
    if (parent.isTextblock && parent.content.size === 0 && depth >= 1 && $from.node(depth - 1).canReplaceWith($from.index(depth - 1), $from.indexAfter(depth - 1), node.type)) {
      pos = $from.before(depth)
      tr.replaceWith(pos, $from.after(depth), node)
    } else {
      // insert after the current top-most block that can hold it
      let d = depth
      while (d > 0 && !$from.node(d - 1).canReplaceWith($from.indexAfter(d - 1), $from.indexAfter(d - 1), node.type)) d--
      pos = d > 0 ? $from.after(d) : $from.end(0)
      tr.insert(pos, node)
    }
    const after = pos + node.nodeSize
    if (opts.select === 'after' || (!node.isTextblock && !node.type.spec.code && opts.select !== 'inside')) {
      const $after = tr.doc.resolve(Math.min(after, tr.doc.content.size))
      if ($after.nodeAfter?.isTextblock) tr.setSelection(TextSelection.create(tr.doc, after + 1))
      else {
        tr.insert(after, S.paragraph.create())
        tr.setSelection(TextSelection.create(tr.doc, after + 1))
      }
    } else {
      tr.setSelection(Selection.near(tr.doc.resolve(pos + 1)))
    }
    dispatch(tr.scrollIntoView())
    return true
  }
}

export function insertCodeBlock(info = ''): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection
    const parent = $from.parent
    if (parent.type === S.paragraph && $from.sameParent($to) && parent.content.size > 0 && !$from.parent.textContent.includes('\n')) {
      // turn this paragraph into a code block with its text
      if (dispatch) {
        const text = parent.textContent
        const node = S.code_block.create({ info }, text ? schema.text(text) : null)
        const tr = state.tr.replaceWith($from.before(), $from.after(), node)
        tr.setSelection(TextSelection.create(tr.doc, $from.before() + 1 + text.length))
        dispatch(tr.scrollIntoView())
      }
      return true
    }
    const template = info === 'mermaid' ? 'graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结果一]\n  B -->|否| D[结果二]' : ''
    return insertBlock(S.code_block.create({ info }, template ? schema.text(template) : null), { select: 'inside' })(state, dispatch)
  }
}

export const insertMathBlock: Command = (state, dispatch) =>
  insertBlock(S.math_block.create(), { select: 'inside' })(state, dispatch)

export const insertHTMLBlock: Command = (state, dispatch) =>
  insertBlock(S.html_block.create(null, schema.text('<div>\n\n</div>')), { select: 'inside' })(state, dispatch)

export const insertHR: Command = (state, dispatch) => insertBlock(S.horizontal_rule.create(), { select: 'after' })(state, dispatch)
export const insertTOC: Command = (state, dispatch) => insertBlock(S.toc.create(), { select: 'after' })(state, dispatch)

export function insertCallout(kind = 'NOTE'): Command {
  return (state, dispatch) => {
    const { $from } = state.selection
    const para = $from.parent.type === S.paragraph && $from.parent.content.size ? $from.parent : null
    const node = S.callout.create({ kind }, [para ? S.paragraph.create(null, para.content) : S.paragraph.create()])
    if (para && dispatch) {
      const tr = state.tr.replaceWith($from.before(), $from.after(), node)
      tr.setSelection(TextSelection.create(tr.doc, $from.before() + 2 + para.content.size))
      dispatch(tr.scrollIntoView())
      return true
    }
    return insertBlock(node, { select: 'inside' })(state, dispatch)
  }
}

export function createTable(rows: number, cols: number, header?: string[]): PMNode {
  const cell = (type: NodeType, text?: string) => type.create(null, text ? schema.text(text) : null)
  const head = S.table_row.create(null, Array.from({ length: cols }, (_, i) => cell(S.table_header, header?.[i])))
  const body = Array.from({ length: Math.max(1, rows - 1) }, () =>
    S.table_row.create(null, Array.from({ length: cols }, () => cell(S.table_cell))))
  return S.table.create(null, [head, ...body])
}

export function insertTable(rows = 3, cols = 3): Command {
  return (state, dispatch) => insertBlock(createTable(rows, cols), { select: 'inside' })(state, dispatch)
}

export const insertFootnote: Command = (state, dispatch) => {
  const used = new Set<string>()
  state.doc.descendants(n => {
    if (n.type === S.footnote_def || n.type === S.footnote_ref) used.add(String(n.attrs.label))
  })
  let i = 1
  while (used.has(String(i))) i++
  const label = String(i)
  if (!dispatch) return true
  const tr = state.tr.replaceSelectionWith(S.footnote_ref.create({ label }), false)
  const end = tr.doc.content.size
  tr.insert(end, S.footnote_def.create({ label }, S.paragraph.create()))
  tr.setSelection(TextSelection.create(tr.doc, end + 2))
  dispatch(tr.scrollIntoView())
  return true
}

export const insertFrontmatter: Command = (state, dispatch) => {
  const first = state.doc.firstChild
  if (first?.type === S.frontmatter) {
    if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, 1 + first.content.size)).scrollIntoView())
    return true
  }
  if (dispatch) {
    const node = S.frontmatter.create(null, schema.text('title: \ntags: []'))
    const tr = state.tr.insert(0, node)
    // drop an empty paragraph the slash command left behind
    const $sel = tr.doc.resolve(tr.mapping.map(state.selection.from))
    if ($sel.parent.type === S.paragraph && !$sel.parent.content.size && tr.doc.childCount > 2) {
      tr.delete($sel.before(), $sel.after())
    }
    tr.setSelection(TextSelection.create(tr.doc, 1 + 'title: '.length))
    dispatch(tr.scrollIntoView())
  }
  return true
}

export function insertImages(srcs: { src: string; alt?: string }[]): Command {
  return (state, dispatch) => {
    if (!dispatch) return true
    const nodes = srcs.map(s => S.image.create({ src: s.src, alt: s.alt || '' }))
    const tr = state.tr
    if (tr.selection.$from.parent.type.spec.code) return false
    tr.replaceSelectionWith(nodes.length === 1 ? nodes[0] : nodes[0], false)
    for (let i = 1; i < nodes.length; i++) tr.insert(tr.selection.from, nodes[i])
    dispatch(tr.scrollIntoView())
    return true
  }
}

export function setLink(href: string | null, text?: string): Command {
  return (state, dispatch) => {
    const { from, to, empty, $from } = state.selection
    if (!dispatch) return true
    let tr = state.tr
    // expand to the whole link when the caret sits inside one
    let start = from, end = to
    if (empty) {
      const link = M.link.isInSet($from.marks())
      if (link) {
        const range = markRange($from, M.link)
        if (range) { start = range.from; end = range.to }
      }
    }
    if (!href) {
      tr = tr.removeMark(start, end, M.link)
    } else if (start === end) {
      const t = text || href
      tr = tr.insertText(t, start, end).addMark(start, start + t.length, M.link.create({ href }))
    } else {
      tr = tr.removeMark(start, end, M.link).addMark(start, end, M.link.create({ href }))
    }
    dispatch(tr.scrollIntoView())
    return true
  }
}

export function markRange($pos: ResolvedPos, type = M.link) {
  const parent = $pos.parent
  const start = parent.childAfter($pos.parentOffset)
  const idx0 = start.node ? start.index : $pos.index() - 1
  let target = start.node && type.isInSet(start.node.marks) ? start.node : null
  let idx = start.index
  if (!target && $pos.parentOffset > 0) {
    const before = parent.childBefore($pos.parentOffset)
    if (before.node && type.isInSet(before.node.marks)) { target = before.node; idx = before.index }
  }
  if (!target || idx0 < -1) return null
  const mark = type.isInSet(target.marks)!
  let startIdx = idx, endIdx = idx + 1
  while (startIdx > 0 && mark.isInSet(parent.child(startIdx - 1).marks)) startIdx--
  while (endIdx < parent.childCount && mark.isInSet(parent.child(endIdx).marks)) endIdx++
  let from = $pos.start(), to
  for (let i = 0; i < startIdx; i++) from += parent.child(i).nodeSize
  to = from
  for (let i = startIdx; i < endIdx; i++) to += parent.child(i).nodeSize
  return { from, to, mark }
}

export const insertMathInline: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection
  const tex = empty ? '' : state.doc.textBetween(from, to)
  if (!dispatch) return true
  const tr = state.tr.replaceSelectionWith(S.math_inline.create({ tex }), false)
  tr.setSelection(NodeSelection.create(tr.doc, from))
  dispatch(tr)
  return true
}

// ------------------------------------------------------------------ block moving

function movableRange(state: EditorState, dir: number, preferTop = false) {
  const { $from, $to } = state.selection
  // inside a list: move list items (unless it is the first / last one)
  const item = preferTop ? null : findAncestor($from, n => n.type === S.list_item)
  if (item && ((dir < 0 && $from.index(item.depth - 1) > 0) || (dir > 0 && $from.index(item.depth - 1) < $from.node(item.depth - 1).childCount - 1))) {
    const listDepth = item.depth - 1
    const $end = state.doc.resolve($to.pos)
    let endIdx = $from.index(listDepth)
    if ($end.depth >= item.depth && $end.node(listDepth) === $from.node(listDepth)) endIdx = $end.index(listDepth)
    return { depth: listDepth, from: $from.index(listDepth), to: endIdx }
  }
  if ($from.depth === 0) {
    // node selection of a top-level block
    const idx = $from.index(0)
    return { depth: 0, from: idx, to: idx }
  }
  let to = $from.index(0)
  if ($to.depth > 0) to = Math.max(to, $to.index(0))
  return { depth: 0, from: $from.index(0), to }
}

export function moveBlock(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const r = movableRange(state, dir)
    const { $from } = state.selection
    const parent = r.depth === 0 ? state.doc : $from.node(r.depth)
    if (dir < 0 && r.from === 0) return false
    if (dir > 0 && r.to >= parent.childCount - 1) return false
    if (!dispatch) return true
    const start = r.depth === 0 ? 0 : $from.start(r.depth)
    const offsetOf = (i: number) => {
      let p = start
      for (let k = 0; k < i; k++) p += parent.child(k).nodeSize
      return p
    }
    const blockFrom = offsetOf(r.from)
    const blockTo = offsetOf(r.to + 1)
    const moving: PMNode[] = []
    for (let i = r.from; i <= r.to; i++) moving.push(parent.child(i))
    const tr = state.tr
    const sel = state.selection
    if (dir < 0) {
      const prev = parent.child(r.from - 1)
      const prevFrom = blockFrom - prev.nodeSize
      tr.replaceWith(prevFrom, blockTo, Fragment.fromArray([...moving, prev]))
      tr.setSelection(safeSelection(tr, sel, -prev.nodeSize))
    } else {
      const next = parent.child(r.to + 1)
      tr.replaceWith(blockFrom, blockTo + next.nodeSize, Fragment.fromArray([next, ...moving]))
      tr.setSelection(safeSelection(tr, sel, next.nodeSize))
    }
    dispatch(tr.scrollIntoView())
    return true
  }
}

function safeSelection(tr: Transaction, sel: Selection, shift: number): Selection {
  const size = tr.doc.content.size
  const clamp = (p: number) => Math.max(0, Math.min(size, p))
  if (sel instanceof NodeSelection) {
    try { return NodeSelection.create(tr.doc, clamp(sel.from + shift)) } catch {}
  }
  try {
    return TextSelection.create(tr.doc, clamp(sel.anchor + shift), clamp(sel.head + shift))
  } catch {
    return Selection.near(tr.doc.resolve(clamp(sel.from + shift)))
  }
}

// ------------------------------------------------------------------ tables

export const tableEnter: Command = (state, dispatch) => {
  if (!isInTable(state)) return false
  const rect = selectedRect(state)
  const map = rect.map
  const col = rect.left
  const row = rect.top
  if (!dispatch) return true
  if (row + 1 >= map.height) {
    addRowAfter(state, tr0 => {
      const table = tr0.doc.nodeAt(rect.tableStart - 1)!
      const newMap = TableMap.get(table)
      const cellPos = newMap.positionAt(row + 1, col, table)
      tr0.setSelection(TextSelection.create(tr0.doc, rect.tableStart + cellPos + 1))
      dispatch(tr0.scrollIntoView())
    })
    return true
  }
  const cellPos = map.positionAt(row + 1, col, rect.table)
  dispatch(state.tr.setSelection(TextSelection.create(state.doc, rect.tableStart + cellPos + 1)).scrollIntoView())
  return true
}

export function setColumnAlign(align: string | null): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false
    if (!dispatch) return true
    const rect = selectedRect(state)
    const tr = state.tr
    for (let r = 0; r < rect.map.height; r++) {
      for (let c = rect.left; c < rect.right; c++) {
        const pos = rect.map.positionAt(r, c, rect.table)
        const cell = rect.table.nodeAt(pos)!
        tr.setNodeMarkup(rect.tableStart + pos, undefined, { ...cell.attrs, align })
      }
    }
    dispatch(tr)
    return true
  }
}

// ------------------------------------------------------------------ misc

export function isPreviewBlock(n: PMNode | null | undefined): boolean {
  if (!n) return false
  if (n.type === S.math_block || n.type === S.html_block || n.type === S.frontmatter) return true
  if (n.type === S.code_block) {
    const l = codeLang(n.attrs.info)
    return l === 'mermaid' || l === 'math' || l === 'katex'
  }
  return false
}

/** ⌘↩: leave the current top-level block (quote, callout, list, table, code …) */
export const exitBlock: Command = (state, dispatch) => {
  const { $head } = state.selection
  if ($head.depth < 1) return false
  const after = $head.after(1)
  if (!dispatch) return true
  const tr = state.tr.insert(after, S.paragraph.create())
  tr.setSelection(TextSelection.create(tr.doc, after + 1))
  dispatch(tr.scrollIntoView())
  return true
}

export { sinkListItem, liftListItem }
