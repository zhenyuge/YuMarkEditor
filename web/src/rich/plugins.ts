import { Fragment, Slice, type Node as PMNode, type ResolvedPos } from 'prosemirror-model'
import { type Command, EditorState, NodeSelection, Plugin, PluginKey, Selection, TextSelection } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap, chainCommands, createParagraphNear, exitCode, joinBackward, lift, liftEmptyBlock, newlineInCode, selectNodeBackward, setBlockType, splitBlockKeepMarks, deleteSelection } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules'
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list'
import { goToNextCell, isInTable, tableEditing } from 'prosemirror-tables'
import { gapCursor } from 'prosemirror-gapcursor'
import { dropCursor } from 'prosemirror-dropcursor'
import { search } from 'prosemirror-search'
import { codeLang, schema } from '../md/schema'
import { parseFragment } from '../md/parse'
import { serializeNodes, inlineMarkdown } from '../md/serialize'
import { highlightRanges, loadHljs, hljs } from '../render'
import {
  createTable, exitBlock, findAncestor, insertMathInline, isPreviewBlock, moveBlock, setHeading, tableEnter,
  toggleBlockquote, toggleCode, toggleEm, toggleList, toggleStrike, toggleStrong,
} from './commands'
import { editorCtx } from './context'
import { tocViews } from './nodeviews'

const S = schema.nodes
const M = schema.marks

// ------------------------------------------------------------------ input rules

function markRule(re: RegExp, type: any, attrs: Record<string, unknown> = {}) {
  // re must capture: 1 = opening delimiter + text + closing delimiter, 2 = text
  return new InputRule(re, (state, match, start, end) => {
    const full = match[1], text = match[2]
    const fullStart = start + match[0].indexOf(full)
    const textStart = fullStart + full.indexOf(text)
    const textEnd = textStart + text.length
    const fullEnd = end
    const $s = state.doc.resolve(fullStart)
    if (!$s.parent.type.allowsMarkType(type)) return null
    if (M.code.isInSet($s.marks())) return null
    const tr = state.tr
    tr.delete(textEnd, fullEnd).delete(fullStart, textStart)
    tr.addMark(fullStart, fullStart + text.length, type.create(attrs))
    tr.removeStoredMark(type)
    return tr
  })
}

const taskRule = new InputRule(/^\[([ xX])\]\s$/, (state, match, start, end) => {
  const $s = state.doc.resolve(start)
  const checked = match[1] !== ' '
  const item = $s.depth >= 2 && $s.node(-1).type === S.list_item && $s.index(-1) === 0 ? $s.node(-1) : null
  if (item) {
    return state.tr.delete(start, end).setNodeMarkup($s.before(-1), undefined, { ...item.attrs, checked })
  }
  if ($s.parent.type !== S.paragraph) return null
  const tr = state.tr.delete(start, end)
  const para = tr.doc.resolve(start).parent
  const pos = $s.before()
  const list = S.bullet_list.create({ tight: true }, S.list_item.create({ checked }, para))
  tr.replaceWith(pos, pos + para.nodeSize, list)
  tr.setSelection(TextSelection.create(tr.doc, pos + 3))
  return tr
})

const calloutRule = new InputRule(/^\[!(\w+)\]([+-]?)\s$/, (state, match, start, end) => {
  const $s = state.doc.resolve(start)
  if ($s.depth < 2 || $s.node(-1).type !== S.blockquote || $s.index(-1) !== 0) return null
  const quote = $s.node(-1)
  const qpos = $s.before(-1)
  const tr = state.tr.delete(start, end)
  const q2 = tr.doc.nodeAt(qpos)!
  tr.replaceWith(qpos, qpos + q2.nodeSize, S.callout.create({ kind: match[1].toUpperCase(), fold: match[2] }, q2.content))
  tr.setSelection(TextSelection.create(tr.doc, start))
  void quote
  return tr
})

const mathInlineRule = new InputRule(/(?:^|[^$\\])(\$([^\s$](?:[^$]*[^\s$\\])?)\$)$/, (state, match, start, end) => {
  const tex = match[2]
  const s = start + match[0].indexOf(match[1])
  const $s = state.doc.resolve(s)
  if (M.code.isInSet($s.marks())) return null
  return state.tr.replaceWith(s, end, S.math_inline.create({ tex }))
})

const linkRule = new InputRule(/(?:^|[^!\\])(\[([^\]]+)\]\(([^()\s]+)(?:\s+"([^"]*)")?\))$/, (state, match, start, end) => {
  const s = start + match[0].indexOf(match[1])
  const text = match[2]
  return state.tr.replaceWith(s, end, schema.text(text, [M.link.create({ href: match[3], title: match[4] || null })]))
})

const imageRule = new InputRule(/(!\[([^\]]*)\]\(([^()\s]+)(?:\s+"([^"]*)")?\))$/, (state, match, start, end) => {
  return state.tr.replaceWith(start, end, S.image.create({ alt: match[2], src: match[3], title: match[4] || null }))
})

export function buildInputRules() {
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, S.heading, m => ({ level: m[1].length })),
      wrappingInputRule(/^\s*[>》]\s$/, S.blockquote),
      calloutRule,
      wrappingInputRule(/^\s*([-+*])\s$/, S.bullet_list, m => ({ bullet: m[1] })),
      wrappingInputRule(/^(\d+)([.)])\s$/, S.ordered_list, m => ({ order: +m[1], delim: m[2] }),
        (m, node) => node.childCount + node.attrs.order === +m[1]),
      taskRule,
      textblockTypeInputRule(/^```([^\s`]*)\s$/, S.code_block, m => ({ info: m[1] })),
      textblockTypeInputRule(/^~~~([^\s~]*)\s$/, S.code_block, m => ({ info: m[1], fence: '~~~' })),
      textblockTypeInputRule(/^\$\$\s$/, S.math_block),
      markRule(/(?:^|[^*\\])(\*\*([^*\s](?:[^*]*[^*\s])?)\*\*)$/, M.strong),
      markRule(/(?:^|[^_\w\\])(__([^_\s](?:[^_]*[^_\s])?)__)$/, M.strong, { markup: '__' }),
      markRule(/(?:^|[^*\\])(\*([^*\s](?:[^*]*[^*\s])?)\*)$/, M.em),
      markRule(/(?:^|[^_\w\\])(_([^_\s](?:[^_]*[^_\s])?)_)$/, M.em, { markup: '_' }),
      markRule(/(?:^|[^`\\])(`([^`]+)`)$/, M.code),
      markRule(/(?:^|[^~\\])(~~([^~\s](?:[^~]*[^~\s])?)~~)$/, M.strike),
      mathInlineRule,
      imageRule,
      linkRule,
    ],
  })
}

// ------------------------------------------------------------------ keymap

const isAtStartOf = ($from: ResolvedPos) => $from.parentOffset === 0

const backspace: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection
  if (!empty || !isAtStartOf($from)) return false
  const parent = $from.parent
  // heading -> paragraph
  if (parent.type === S.heading) return setBlockType(S.paragraph)(state, dispatch)
  // empty code-like block -> paragraph
  if (parent.type.spec.code && parent.content.size === 0) {
    if (dispatch) {
      const tr = state.tr.replaceWith($from.before(), $from.after(), S.paragraph.create())
      tr.setSelection(TextSelection.create(tr.doc, $from.before() + 1))
      dispatch(tr)
    }
    return true
  }
  if (parent.type.spec.code) return true
  if ($from.depth >= 2) {
    const container = $from.node(-1)
    const first = $from.index(-1) === 0
    if (container.type === S.list_item && first) {
      if (container.attrs.checked != null) {
        dispatch?.(state.tr.setNodeMarkup($from.before(-1), undefined, { ...container.attrs, checked: null }))
        return true
      }
      return liftListItem(S.list_item)(state, dispatch)
    }
    if ((container.type === S.blockquote || container.type === S.callout || container.type === S.footnote_def) && first) {
      return lift(state, dispatch)
    }
  }
  void view
  return false
}

/** Enter in a paragraph whose whole text is a markdown block opener. */
const enterShortcuts: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type !== S.paragraph || $from.parentOffset !== $from.parent.content.size) return false
  const text = $from.parent.textContent
  if ($from.parent.childCount > 1 || ($from.parent.firstChild && !$from.parent.firstChild.isText)) return false
  const replaceWith = (node: PMNode, inside: boolean, extraPara = false) => {
    if (!dispatch) return true
    const start = $from.before(), end = $from.after()
    const tr = state.tr.replaceWith(start, end, extraPara ? [node, S.paragraph.create()] : node)
    tr.setSelection(inside ? Selection.near(tr.doc.resolve(start + 1)) : TextSelection.create(tr.doc, start + node.nodeSize + 1))
    dispatch(tr.scrollIntoView())
    return true
  }
  let m: RegExpExecArray | null
  if ((m = /^(```|~~~)([^\s`]*)\s*$/.exec(text))) return replaceWith(S.code_block.create({ info: m[2], fence: m[1] }), true)
  if (/^\$\$$/.test(text)) return replaceWith(S.math_block.create(), true)
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(text)) {
    if (text === '---' && $from.depth === 1 && $from.index(0) === 0 && state.doc.firstChild?.type !== S.frontmatter) {
      return replaceWith(S.frontmatter.create(), true)
    }
    if ($from.depth !== 1) return false
    return replaceWith(S.horizontal_rule.create({ markup: text }), false, true)
  }
  if (/^\[toc\]$/i.test(text) && $from.depth === 1) return replaceWith(S.toc.create({ markup: text }), false, true)
  if ((m = /^\|(.+)\|\s*$/.exec(text)) && $from.depth === 1) {
    const cells = m[1].split('|').map(s => s.trim())
    if (cells.length >= 1) {
      const table = createTable(2, cells.length, cells)
      if (!dispatch) return true
      const start = $from.before()
      const tr = state.tr.replaceWith(start, $from.after(), table)
      // caret into first body cell
      const bodyRow = table.child(0).nodeSize
      tr.setSelection(TextSelection.create(tr.doc, start + 1 + bodyRow + 2))
      dispatch(tr.scrollIntoView())
      return true
    }
  }
  return false
}

const codeEnter: Command = (state, dispatch) => {
  const { $head, $anchor } = state.selection
  if (!$head.parent.type.spec.code || !$head.sameParent($anchor)) return false
  const text = $head.parent.textContent
  const lineStart = text.lastIndexOf('\n', $head.parentOffset - 1) + 1
  const indent = /^[ \t]*/.exec(text.slice(lineStart))![0]
  if (dispatch) dispatch(state.tr.insertText('\n' + indent).scrollIntoView())
  return true
}

const codeTab: Command = (state, dispatch) => {
  const { $head } = state.selection
  if (!$head.parent.type.spec.code) return false
  if (dispatch) dispatch(state.tr.insertText('    ').scrollIntoView())
  return true
}

const codeShiftTab: Command = (state, dispatch) => {
  const { $head } = state.selection
  if (!$head.parent.type.spec.code) return false
  const text = $head.parent.textContent
  const lineStart = text.lastIndexOf('\n', $head.parentOffset - 1) + 1
  const m = /^( {1,4}|\t)/.exec(text.slice(lineStart))
  if (m && dispatch) {
    const pos = $head.start() + lineStart
    dispatch(state.tr.delete(pos, pos + m[0].length))
  }
  return true
}

const selectAllInCode: Command = (state, dispatch) => {
  const { $from, $to } = state.selection
  if (!$from.parent.type.spec.code || !$from.sameParent($to)) return false
  const start = $from.start(), end = $from.end()
  if ($from.pos === start && $to.pos === end) return false
  dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, start, end)))
  return true
}

/** Arrow keys: step into hidden-source preview blocks; leave code blocks at doc end. */
function arrow(dir: 'up' | 'down' | 'left' | 'right'): Command {
  return (state, dispatch, view) => {
    const sel = state.selection
    if (!(sel instanceof TextSelection) || !sel.empty || !view) return false
    const forward = dir === 'down' || dir === 'right'
    if (!view.endOfTextblock(dir)) return false
    const $head = sel.$head
    // at end of doc inside a code-like block or table: create a paragraph after
    if (forward && $head.depth >= 1) {
      const top = $head.node(1)
      const isLast = $head.index(0) === state.doc.childCount - 1
      if (isLast && (top.type.spec.code || top.type === S.table)) {
        const inLastPart = top.type !== S.table || $head.index(1) === top.childCount - 1
        if (inLastPart) {
          if (dispatch) {
            const tr = state.tr.insert(state.doc.content.size, S.paragraph.create())
            dispatch(tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1)).scrollIntoView())
          }
          return true
        }
      }
    }
    // neighbouring preview block?
    const depth = $head.depth
    const blockPos = forward ? $head.after(depth) : $head.before(depth)
    const $b = state.doc.resolve(blockPos)
    const neighbour = forward ? $b.nodeAfter : $b.nodeBefore
    if (neighbour && isPreviewBlock(neighbour)) {
      if (dispatch) {
        const inner = forward ? blockPos + 1 : blockPos - 1
        dispatch(state.tr.setSelection(TextSelection.create(state.doc, inner)).scrollIntoView())
      }
      return true
    }
    return false
  }
}

const hardBreak: Command = (state, dispatch) => {
  const { $from } = state.selection
  if ($from.parent.type.spec.code) return newlineInCode(state, dispatch)
  if (dispatch) dispatch(state.tr.replaceSelectionWith(S.hard_break.create()).scrollIntoView())
  return true
}

export function buildKeymaps(cmds: { onLink: () => void; onFind: () => void }) {
  const list = (cmd: Command): Command => (state, dispatch, view) => cmd(state, dispatch, view)
  return [
    keymap({
      'Mod-z': undo,
      'Shift-Mod-z': redo,
      'Mod-y': redo,
      'Mod-b': toggleStrong,
      'Mod-i': toggleEm,
      'Mod-Shift-x': toggleStrike,
      'Ctrl-`': toggleCode,
      'Mod-Shift-`': toggleCode,
      'Ctrl-m': insertMathInline,
      'Mod-k': () => { cmds.onLink(); return true },
      'Mod-Alt-0': setHeading(0),
      'Mod-Alt-1': setHeading(1),
      'Mod-Alt-2': setHeading(2),
      'Mod-Alt-3': setHeading(3),
      'Mod-Alt-4': setHeading(4),
      'Mod-Alt-5': setHeading(5),
      'Mod-Alt-6': setHeading(6),
      'Mod-Alt-q': toggleBlockquote,
      'Mod-Alt-u': toggleList('bullet'),
      'Mod-Alt-o': toggleList('ordered'),
      'Mod-Alt-x': toggleList('task'),
      'Alt-ArrowUp': moveBlock(-1),
      'Alt-ArrowDown': moveBlock(1),
      'Mod-a': selectAllInCode,
      Enter: chainCommands(codeEnter, list(tableEnter), enterShortcuts, splitListItem(S.list_item),
        createParagraphNear, liftEmptyBlock, splitBlockKeepMarks),
      'Shift-Enter': hardBreak,
      'Mod-Enter': chainCommands(exitCode, exitBlock),
      Tab: chainCommands(codeTab, goToNextCell(1), sinkListItem(S.list_item), () => true),
      'Shift-Tab': chainCommands(codeShiftTab, goToNextCell(-1), liftListItem(S.list_item), () => true),
      Backspace: chainCommands(deleteSelection, backspace, joinBackward, selectNodeBackward),
      ArrowUp: arrow('up'),
      ArrowDown: arrow('down'),
      ArrowLeft: arrow('left'),
      ArrowRight: arrow('right'),
    }),
    keymap(baseKeymap),
  ]
}

// ------------------------------------------------------------------ decorations

const editingKey = new PluginKey('editing')

/** Mark the preview block that holds the caret so its source becomes visible. */
export const editingPlugin = new Plugin({
  key: editingKey,
  props: {
    decorations(state) {
      const { $from } = state.selection
      const decos: Decoration[] = []
      const sel = state.selection
      if (sel instanceof NodeSelection && isPreviewBlock(sel.node)) {
        decos.push(Decoration.node(sel.from, sel.to, {}, { editing: true }))
      }
      for (let d = $from.depth; d > 0; d--) {
        const n = $from.node(d)
        if (isPreviewBlock(n)) {
          decos.push(Decoration.node($from.before(d), $from.after(d), {}, { editing: true }))
          break
        }
      }
      return decos.length ? DecorationSet.create(state.doc, decos) : null
    },
  },
})

const hlKey = new PluginKey('highlight')
const nodeDecoCache = new WeakMap<PMNode, { from: number; to: number; cls: string }[]>()

function codeDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = []
  let needLoad = false
  doc.descendants((node, pos) => {
    if (node.type !== S.code_block) return !node.isTextblock
    const lang = codeLang(node.attrs.info)
    if (!lang || lang === 'mermaid' || lang === 'math') return false
    let ranges = nodeDecoCache.get(node)
    if (!ranges) {
      const r = highlightRanges(node.textContent, lang)
      if (!r) { needLoad = true; return false }
      ranges = r
      nodeDecoCache.set(node, r)
    }
    for (const r of ranges) decos.push(Decoration.inline(pos + 1 + r.from, pos + 1 + r.to, { class: r.cls }))
    return false
  })
  if (needLoad && !hljs) loadHljs().then(() => pendingViews.forEach(v => v.dispatch(v.state.tr.setMeta(hlKey, 'reload'))))
  return DecorationSet.create(doc, decos)
}

const pendingViews = new Set<EditorView>()

export const highlightPlugin = new Plugin({
  key: hlKey,
  state: {
    init: (_, state) => codeDecorations(state.doc),
    apply(tr, old, _o, state) {
      if (tr.docChanged || tr.getMeta(hlKey)) return codeDecorations(state.doc)
      return old
    },
  },
  props: { decorations: state => hlKey.getState(state) },
  view(view) {
    pendingViews.add(view)
    return { destroy: () => pendingViews.delete(view) }
  },
})

export const placeholderPlugin = new Plugin({
  props: {
    decorations(state) {
      const doc = state.doc
      if (doc.childCount !== 1 || doc.firstChild!.type !== S.paragraph || doc.firstChild!.content.size) return null
      return DecorationSet.create(doc, [Decoration.node(0, doc.firstChild!.nodeSize, { class: 'is-empty', 'data-placeholder': '开始写作…　输入 / 插入标题、表格、公式、图表' })])
    },
  },
})

export const tocPlugin = new Plugin({
  view() {
    return {
      update(view, prev) {
        if (!prev.doc.eq(view.state.doc)) for (const t of tocViews) if (t.view === view) t.render()
      },
    }
  },
})

// ------------------------------------------------------------------ clipboard / paste

function sliceToMarkdown(slice: Slice, env: any): string {
  const content = slice.content
  if (content.childCount && content.firstChild!.isInline) {
    return inlineMarkdown(S.paragraph.create(null, content), { env }, 'para')
  }
  const nodes: PMNode[] = []
  content.forEach(n => {
    if (n.isInline) nodes.push(S.paragraph.create(null, n))
    else if (n.type === S.list_item) nodes.push(S.bullet_list.create(null, n))
    else if (n.type === S.table_row) nodes.push(S.table.create(null, n))
    else nodes.push(n)
  })
  try { return serializeNodes(nodes, { env }) } catch { return slice.content.textBetween(0, slice.content.size, '\n\n') }
}

const MD_HINT = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\|.*\||\$\$)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|`[^`]+`|!\[/

export function clipboardPlugin(getEnv: () => any) {
  return new Plugin({
    props: {
      clipboardTextSerializer: (slice: Slice) => sliceToMarkdown(slice, getEnv()),
      clipboardTextParser(text, $context, plain) {
        if (plain || $context.parent.type.spec.code) return null as any
        if (!MD_HINT.test(text)) return null as any
        const nodes = parseFragment(text.replace(/\r\n?/g, '\n'), getEnv())
        if (!nodes.length) return null as any
        const frag = Fragment.fromArray(nodes)
        // a single paragraph pastes inline
        if (nodes.length === 1 && nodes[0].type === S.paragraph) return new Slice(nodes[0].content, 0, 0)
        return new Slice(frag, 0, 0)
      },
      handlePaste(view, event) {
        const files = imageFiles(event.clipboardData)
        if (!files.length) return false
        event.preventDefault()
        insertImageFiles(view, files, view.state.selection.from)
        return true
      },
      handleDrop(view, event) {
        const dt = (event as DragEvent).dataTransfer
        const files = imageFiles(dt)
        if (!files.length) return false
        event.preventDefault()
        const pos = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })
        insertImageFiles(view, files, pos ? pos.pos : view.state.selection.from)
        return true
      },
    },
  })
}

function imageFiles(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return []
  const out: File[] = []
  for (const f of Array.from(dt.files || [])) if (/^image\//.test(f.type)) out.push(f)
  if (!out.length) {
    for (const item of Array.from(dt.items || [])) {
      if (item.kind === 'file' && /^image\//.test(item.type)) { const f = item.getAsFile(); if (f) out.push(f) }
    }
  }
  return out
}

async function insertImageFiles(view: EditorView, files: File[], pos: number) {
  for (const f of files) {
    const buf = await f.arrayBuffer()
    const src = await editorCtx.storeImage(buf, f.type, f.name)
    if (!src) continue
    const state = view.state
    const at = Math.min(pos, state.doc.content.size)
    const $at = state.doc.resolve(at)
    const node = S.image.create({ src, alt: '' })
    let tr = state.tr
    if ($at.parent.inlineContent && !$at.parent.type.spec.code) tr = tr.insert(at, node)
    else tr = tr.insert(at, S.paragraph.create(null, node))
    view.dispatch(tr.scrollIntoView())
    pos = at + node.nodeSize
  }
}

// ------------------------------------------------------------------ links

export const linkClickPlugin = new Plugin({
  props: {
    handleDOMEvents: {
      click(view, event) {
        const a = (event.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
        if (a) event.preventDefault()
        if (!event.metaKey) return false
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })
        if (!pos) return false
        const $p = view.state.doc.resolve(pos.pos)
        const link = M.link.isInSet($p.marks()) || ($p.nodeAfter && M.link.isInSet($p.nodeAfter.marks))
        if (link) {
          event.preventDefault()
          editorCtx.openLink(link.attrs.href)
          return true
        }
        const fnRef = $p.nodeAfter?.type === S.footnote_ref ? $p.nodeAfter : null
        if (fnRef) {
          document.getElementById('fn-' + fnRef.attrs.label)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          return true
        }
        return false
      },
    },
  },
})

export function basePlugins(opts: { onLink: () => void; onFind: () => void; getEnv: () => any; extra?: Plugin[] }) {
  return [
    // menus first so they see Enter / arrows / Escape before the keymaps
    ...(opts.extra || []),
    buildInputRules(),
    ...buildKeymaps(opts),
    history(),
    dropCursor({ color: 'var(--accent)', width: 2 }),
    gapCursor(),
    tableEditing(),
    search(),
    editingPlugin,
    highlightPlugin,
    placeholderPlugin,
    tocPlugin,
    clipboardPlugin(opts.getEnv),
    linkClickPlugin,
  ]
}

export { isInTable }
