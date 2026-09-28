// Markdown text -> ProseMirror document, remembering the exact source slice of
// every top-level block so untouched blocks can be written back verbatim.
import { Mark, type Node as PMNode, type NodeType } from 'prosemirror-model'
import { md, type ParseEnv } from './markdown'
import { schema } from './schema'

type Token = any

export interface SourceInfo {
  eol: '\n' | '\r\n'
  bom: boolean
  prefix: string
  nodes: PMNode[]
  srcs: string[]
  /** whitespace after each block; the last one is the file's trailing text */
  gaps: string[]
  env: ParseEnv
}

const S = schema.nodes
const M = schema.marks

md.normalizeLink = (url: string) => url

export function detectEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) || []).length
  const lf = (text.match(/\n/g) || []).length - crlf
  return crlf > lf ? '\r\n' : '\n'
}

function inlineContent(children: Token[] | null): PMNode[] {
  const out: PMNode[] = []
  if (!children) return out
  let marks: readonly Mark[] = Mark.none
  const text = (s: string, extra?: Mark) => {
    if (!s) return
    out.push(schema.text(s, extra ? extra.addToSet(marks) : marks))
  }
  for (const tok of children) {
    switch (tok.type) {
      case 'text':
      case 'text_special':
        text(tok.content)
        break
      case 'softbreak':
        text('\n')
        break
      case 'hardbreak':
        out.push(S.hard_break.create(null, null, marks))
        break
      case 'code_inline':
        text(tok.content, M.code.create())
        break
      case 'em_open':
        marks = M.em.create({ markup: tok.markup }).addToSet(marks)
        break
      case 'em_close':
        marks = M.em.removeFromSet(marks)
        break
      case 'strong_open':
        marks = M.strong.create({ markup: tok.markup }).addToSet(marks)
        break
      case 'strong_close':
        marks = M.strong.removeFromSet(marks)
        break
      case 's_open':
        marks = M.strike.create({ markup: tok.markup }).addToSet(marks)
        break
      case 's_close':
        marks = M.strike.removeFromSet(marks)
        break
      case 'link_open':
        marks = M.link.create({
          href: tok.attrGet('href') || '',
          title: tok.attrGet('title') || null,
          markup: tok.markup || null,
        }).addToSet(marks)
        break
      case 'link_close':
        marks = M.link.removeFromSet(marks)
        break
      case 'image':
        out.push(S.image.create({
          src: tok.attrGet('src') || '',
          alt: tok.children ? tok.children.map((c: Token) => c.content).join('') : tok.content,
          title: tok.attrGet('title') || null,
        }, null, marks))
        break
      case 'html_inline':
        out.push(S.html_inline.create({ html: tok.content }, null, marks))
        break
      case 'math_inline':
        out.push(S.math_inline.create({ tex: tok.content, markup: tok.markup }, null, marks))
        break
      case 'footnote_ref':
        out.push(S.footnote_ref.create({ label: tok.meta.label }, null, marks))
        break
      default:
        if (tok.content) text(tok.content)
    }
  }
  return out
}

function stripNl(s: string) {
  return s.endsWith('\n') ? s.slice(0, -1) : s
}

function make(type: NodeType, attrs: any, content: PMNode[] | PMNode | null): PMNode | null {
  try {
    return type.createChecked(attrs, content as any)
  } catch {
    return type.createAndFill(attrs, content as any)
  }
}

interface Frame { type: NodeType; attrs: any; content: PMNode[]; map: [number, number] | null }

/** Convert a markdown-it token stream to top-level PM nodes (with line maps). */
export function tokensToNodes(tokens: Token[]): { nodes: PMNode[]; maps: ([number, number] | null)[] } {
  const root: Frame = { type: S.doc, attrs: null, content: [], map: null }
  const stack: Frame[] = [root]
  const maps: ([number, number] | null)[] = []
  const top = () => stack[stack.length - 1]
  const add = (node: PMNode | null, map: [number, number] | null) => {
    if (!node) return
    top().content.push(node)
    if (stack.length === 1) maps.push(map)
  }
  const open = (type: NodeType, attrs: any, tok: Token) => {
    stack.push({ type, attrs, content: [], map: tok.map || null })
  }
  const close = () => {
    const f = stack.pop()!
    let content = f.content
    if (!content.length && (f.type === S.blockquote || f.type === S.list_item || f.type === S.footnote_def)) {
      content = [S.paragraph.create()]
    }
    add(make(f.type, f.attrs, content), f.map)
  }
  const code = (type: NodeType, attrs: any, text: string, tok: Token) => {
    add(make(type, attrs, text ? schema.text(text) : null), tok.map || null)
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    switch (tok.type) {
      case 'paragraph_open': open(S.paragraph, null, tok); break
      case 'heading_open':
        open(S.heading, { level: +tok.tag.slice(1), setext: tok.markup === '=' || tok.markup === '-' }, tok)
        break
      case 'blockquote_open': open(S.blockquote, null, tok); break
      case 'callout_open': open(S.callout, { ...tok.meta }, tok); break
      case 'footnote_def_open': open(S.footnote_def, { label: tok.meta.label }, tok); break
      case 'bullet_list_open':
        open(S.bullet_list, { bullet: tok.markup || '-', tight: listIsTight(tokens, i) }, tok)
        break
      case 'ordered_list_open':
        open(S.ordered_list, {
          order: +(tok.attrGet('start') ?? 1),
          delim: tok.markup || '.',
          tight: listIsTight(tokens, i),
          same: listUsesSameNumber(tokens, i),
        }, tok)
        break
      case 'list_item_open': open(S.list_item, { checked: tok.meta?.checked ?? null }, tok); break
      case 'table_open': open(S.table, null, tok); break
      case 'tr_open': open(S.table_row, null, tok); break
      case 'th_open':
      case 'td_open': {
        const style = tok.attrGet('style') || ''
        const m = /text-align:\s*(\w+)/.exec(style)
        open(tok.type === 'th_open' ? S.table_header : S.table_cell, { align: m ? m[1] : null }, tok)
        break
      }
      case 'thead_open': case 'thead_close': case 'tbody_open': case 'tbody_close':
        break
      case 'paragraph_close': case 'heading_close': case 'blockquote_close': case 'callout_close':
      case 'footnote_def_close': case 'bullet_list_close': case 'ordered_list_close': case 'list_item_close':
      case 'table_close': case 'tr_close': case 'th_close': case 'td_close':
        close()
        break
      case 'inline':
        top().content.push(...inlineContent(tok.children))
        break
      case 'fence':
        code(S.code_block, { info: tok.info || '', fence: tok.markup || '```', indented: false }, stripNl(tok.content), tok)
        break
      case 'code_block':
        code(S.code_block, { info: '', fence: '```', indented: true }, stripNl(tok.content), tok)
        break
      case 'math_block':
        code(S.math_block, { markup: tok.markup }, tok.content, tok)
        break
      case 'html_block':
        code(S.html_block, null, stripNl(tok.content), tok)
        break
      case 'front_matter':
        code(S.frontmatter, { fence: tok.markup }, tok.content, tok)
        break
      case 'ref_def':
        code(S.ref_def, null, tok.content, tok)
        break
      case 'hr':
        add(S.horizontal_rule.create({ markup: tok.markup || '---' }), tok.map || null)
        break
      case 'toc':
        add(S.toc.create({ markup: tok.markup || '[TOC]' }), tok.map || null)
        break
      default:
        break
    }
  }
  while (stack.length > 1) close()
  return { nodes: root.content, maps }
}

// markdown-it hides the paragraphs of tight lists; a list without direct
// paragraphs (only headings, quotes, code …) is tight as well.
function listIsTight(tokens: Token[], i: number) {
  const level = tokens[i].level + 2
  for (let j = i + 1; j < tokens.length && tokens[j].level > tokens[i].level; j++) {
    if (tokens[j].type === 'paragraph_open' && tokens[j].level === level) return !!tokens[j].hidden
  }
  return true
}

function listUsesSameNumber(tokens: Token[], i: number) {
  const level = tokens[i].level + 1
  const nums: string[] = []
  for (let j = i + 1; j < tokens.length && tokens[j].level >= level; j++) {
    if (tokens[j].type === 'list_item_open' && tokens[j].level === level) nums.push(tokens[j].info)
  }
  return nums.length > 1 && nums.every(n => n === nums[0])
}

/** Parse markdown into a document plus the source table used for faithful saving. */
export function parseMarkdown(input: string): { doc: PMNode; info: SourceInfo } {
  let text = input
  let bom = false
  if (text.charCodeAt(0) === 0xfeff) { bom = true; text = text.slice(1) }
  const env: ParseEnv = {}
  const tokens = md.parse(text, env)
  const { nodes, maps } = tokensToNodes(tokens)

  // line table over the ORIGINAL text (CRLF kept) — markdown-it counts lines the same way
  const starts: number[] = [0]
  const ends: number[] = []
  const re = /\r\n|\r|\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) { ends.push(m.index); starts.push(m.index + m[0].length) }
  ends.push(text.length)
  const nLines = ends.length
  const blank = (n: number) => /^[ \t]*$/.test(text.slice(starts[n], ends[n]))

  const srcs: string[] = []
  const bounds: [number, number][] = []
  for (let i = 0; i < nodes.length; i++) {
    const map = maps[i] || [0, 0]
    const s = Math.min(map[0], nLines - 1)
    let last = Math.max(s, Math.min(map[1], nLines) - 1)
    while (last > s && blank(last)) last--
    let a = starts[s]
    let b = ends[last]
    const prevEnd = i ? bounds[i - 1][1] : 0
    if (a < prevEnd) a = prevEnd
    if (b < a) b = a
    bounds.push([a, b])
  }
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i][1] > bounds[i + 1][0]) bounds[i][1] = bounds[i + 1][0]
  }
  const gaps: string[] = []
  for (let i = 0; i < bounds.length; i++) {
    srcs.push(text.slice(bounds[i][0], bounds[i][1]))
    gaps.push(text.slice(bounds[i][1], i + 1 < bounds.length ? bounds[i + 1][0] : text.length))
  }
  const prefix = bounds.length ? text.slice(0, bounds[0][0]) : text

  const docContent = nodes.length ? nodes : [S.paragraph.create()]
  const doc = S.doc.create(null, docContent)
  return {
    doc,
    info: { eol: detectEol(text), bom, prefix, nodes, srcs, gaps, env },
  }
}

/** Parse a markdown fragment (e.g. pasted text) into block nodes. */
export function parseFragment(text: string, env?: ParseEnv): PMNode[] {
  const e: ParseEnv = { ...(env || {}) }
  return tokensToNodes(md.parse(text, e)).nodes
}
