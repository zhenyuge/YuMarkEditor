// ProseMirror -> Markdown. Escapes as little as possible: each rendered
// textblock is re-parsed and compared with the document, and only if that
// fails do we fall back to more conservative escaping.
import { Fragment, type Mark, type Node as PMNode } from 'prosemirror-model'
import { md, type ParseEnv } from './markdown'
import { tokensToNodes } from './parse'
import { schema } from './schema'

export interface SerializeCtx {
  env: ParseEnv
}

type EscMode = 'min' | 'cons'
type InlineMode = 'para' | 'atx' | 'setext' | 'cell'

interface InlineOpts {
  esc: EscMode
  star: boolean
  mode: InlineMode
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/
const isWs = (c: string | undefined) => c === undefined || /\s/.test(c)
const isAlnum = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c)

function normalizeRef(label: string) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase()
}

function couldFormMath(s: string): boolean {
  if (s.includes('$$')) return true
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '$' || (i && s[i - 1] === '\\')) continue
    if (isWs(s[i + 1])) continue
    for (let j = i + 2; j < s.length; j++) {
      if (s[j] === '$' && s[j - 1] !== '\\' && !isWs(s[j - 1]) && !/\d/.test(s[j + 1] || '')) return true
    }
  }
  return false
}

function bracketLooksLinky(s: string, i: number, env: ParseEnv): boolean {
  let j = i + 1
  let depth = 0
  for (; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue }
    if (s[j] === '[') depth++
    else if (s[j] === ']') { if (depth === 0) break; depth-- }
  }
  if (j >= s.length) return false
  const label = s.slice(i + 1, j)
  const after = s[j + 1]
  if (after === '(' || after === '[' || after === ':') return true
  if (label.startsWith('^') && env.footnotes?.[label.slice(1)]) return true
  if (label && env.references && env.references[normalizeRef(label)]) return true
  return false
}

function escapeLineStart(line: string, escaped: string): string {
  if (/^#{1,6}(\s|$)/.test(line)) return '\\' + escaped
  if (/^>/.test(line)) return escaped.startsWith('\\') ? escaped : '\\' + escaped
  if (/^([-*_])(\s*\1){2,}\s*$/.test(line)) return escaped.startsWith('\\') ? escaped : '\\' + escaped
  if (/^[-+*](\s|$)/.test(line)) return escaped.startsWith('\\') ? escaped : '\\' + escaped
  if (/^=+\s*$/.test(line)) return '\\' + escaped
  let m = /^(\d{1,9})([.)])(\s|$)/.exec(line)
  if (m) return m[1] + '\\' + escaped.slice(m[1].length)
  if (/^(~~~|\$\$)/.test(line) && !escaped.startsWith('\\')) return '\\' + escaped
  if (/^\[(\^?[^\]]*\]:|toc\]\s*$|[ xX]\](\s|$)|!)/i.test(line) && !escaped.startsWith('\\')) return '\\' + escaped
  return escaped
}

export function escapeText(s: string, startOfLine: boolean, mode: EscMode, env: ParseEnv, inCell: boolean): string {
  if (!s) return s
  const math = s.includes('$') && (mode === 'cons' || couldFormMath(s))
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], prev = s[i - 1], next = s[i + 1]
    switch (ch) {
      case '\\':
        out += next === undefined || ASCII_PUNCT.test(next) ? '\\\\' : '\\'
        break
      case '`':
        out += '\\`'
        break
      case '*':
        out += mode === 'min' && isWs(prev) && isWs(next) ? '*' : '\\*'
        break
      case '_':
        out += mode === 'min' && ((isAlnum(prev) && isAlnum(next)) || (isWs(prev) && isWs(next))) ? '_' : '\\_'
        break
      case '~':
        out += mode === 'cons' || next === '~' || prev === '~' ? '\\~' : '~'
        break
      case '[':
        out += mode === 'cons' || bracketLooksLinky(s, i, env) ? '\\[' : '['
        break
      case ']':
        out += mode === 'cons' ? '\\]' : ']'
        break
      case '<':
        out += mode === 'cons' || /[A-Za-z/!?]/.test(next || '') ? '\\<' : '<'
        break
      case '&':
        out += /^&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(s.slice(i)) ? '\\&' : '&'
        break
      case '$':
        out += math ? '\\$' : '$'
        break
      case '|':
        out += inCell ? '\\|' : '|'
        break
      default:
        out += ch
    }
  }
  if (startOfLine) {
    const lead = /^[ \t]+/.exec(out)
    if (lead) { out = out.slice(lead[0].length); s = s.slice(lead[0].length) }
    out = escapeLineStart(s, out)
  }
  return out
}

// ------------------------------------------------------------------ inline

function backticksFor(node: PMNode, side: number): string {
  const text = node.isText ? node.text! : ''
  let len = 0
  const re = /`+/g
  let m
  while ((m = re.exec(text))) len = Math.max(len, m[0].length)
  const fence = '`'.repeat(len + 1)
  const pad = text.startsWith('`') || text.endsWith('`')
  const bothSpace = text.length > 1 && text.startsWith(' ') && text.endsWith(' ') && /\S/.test(text)
  const space = pad || bothSpace ? ' ' : ''
  return side < 0 ? fence + space : space + fence
}

function isPlainURL(link: Mark, parent: PMNode, index: number): boolean {
  const markup = link.attrs.markup
  if (markup !== 'autolink' && markup !== 'linkify') return false
  const content = parent.child(index)
  if (!content.isText || link.attrs.title) return false
  if (index + 1 < parent.childCount && link.isInSet(parent.child(index + 1).marks)) return false
  if (index > 0 && link.isInSet(parent.child(index - 1).marks)) return false
  if (content.marks.length !== 1) return false
  const text = content.text!
  const href = link.attrs.href as string
  if (markup === 'autolink') return text === href || href === 'mailto:' + text
  const found = md.linkify.match(text)
  return !!found && found.length === 1 && found[0].index === 0 && found[0].lastIndex === text.length && found[0].url === href
}

function linkDest(href: string): string {
  if (!href) return '<>'
  if (/[\s<>]/.test(href) || /[()]/.test(href) && !balanced(href)) return '<' + href.replace(/[<>]/g, '\\$&') + '>'
  return href
}

function balanced(s: string) {
  let d = 0
  for (const c of s) {
    if (c === '(') d++
    else if (c === ')' && --d < 0) return false
  }
  return d === 0
}

function linkTitle(title: string | null): string {
  if (!title) return ''
  return ' "' + title.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

class InlineWriter {
  out = ''
  atStart = true
  inAutolink = false
  constructor(private ctx: SerializeCtx, private opts: InlineOpts) {}

  text(text: string, escape: boolean) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (i) this.out += '\n'
      // trailing spaces before a newline would turn a soft break into a hard one
      if (i < lines.length - 1) lines[i] = lines[i].replace(/[ \t]+$/, '')
      const startOfLine = i > 0 || this.atStart
      this.out += escape ? escapeText(lines[i], startOfLine, this.opts.esc, this.ctx.env, this.opts.mode === 'cell') : lines[i]
      if (lines[i]) this.atStart = false
    }
  }

  markOpen(mark: Mark, parent: PMNode, index: number): string {
    switch (mark.type.name) {
      case 'em': return this.opts.star ? '*' : mark.attrs.markup || '*'
      case 'strong': return this.opts.star ? '**' : mark.attrs.markup || '**'
      case 'strike': return '~~'
      case 'code': return backticksFor(parent.child(index), -1)
      case 'link':
        this.inAutolink = isPlainURL(mark, parent, index)
        if (this.inAutolink) return mark.attrs.markup === 'autolink' ? '<' : ''
        if (/(^|[^\\])!$/.test(this.out)) this.out = this.out.slice(0, -1) + '\\!'
        return '['
    }
    return ''
  }

  markClose(mark: Mark, parent: PMNode, index: number): string {
    switch (mark.type.name) {
      case 'em': return this.opts.star ? '*' : mark.attrs.markup || '*'
      case 'strong': return this.opts.star ? '**' : mark.attrs.markup || '**'
      case 'strike': return '~~'
      case 'code': return backticksFor(parent.child(index - 1), 1)
      case 'link': {
        const auto = this.inAutolink
        this.inAutolink = false
        if (auto) return mark.attrs.markup === 'autolink' ? '>' : ''
        return '](' + linkDest(mark.attrs.href) + linkTitle(mark.attrs.title) + ')'
      }
    }
    return ''
  }

  node(node: PMNode, parent: PMNode, index: number) {
    const mode = this.opts.mode
    switch (node.type.name) {
      case 'text': {
        let t = node.text!
        if (mode !== 'para' && mode !== 'setext') t = t.replace(/\n/g, ' ')
        this.text(t, !this.inAutolink)
        break
      }
      case 'hard_break': {
        let rest = false
        for (let i = index + 1; i < parent.childCount; i++) if (parent.child(i).type !== node.type) { rest = true; break }
        if (!rest) break
        if (mode === 'cell') this.out += '<br>'
        else if (mode === 'atx') this.out += ' '
        else { this.out += '\\\n'; this.atStart = true }
        break
      }
      case 'image': {
        const alt = (node.attrs.alt || '').replace(/[\\[\]]/g, '\\$&')
        this.out += '![' + alt + '](' + linkDest(node.attrs.src) + linkTitle(node.attrs.title) + ')'
        this.atStart = false
        break
      }
      case 'math_inline':
        this.out += node.attrs.markup + node.attrs.tex + node.attrs.markup
        this.atStart = false
        break
      case 'html_inline':
        this.out += node.attrs.html
        this.atStart = false
        break
      case 'footnote_ref':
        this.out += '[^' + node.attrs.label + ']'
        this.atStart = false
        break
    }
  }

  // Adapted from prosemirror-markdown's renderInline (MIT).
  render(parent: PMNode) {
    const EXPEL = new Set(['em', 'strong', 'strike'])
    let active: Mark[] = []
    let trailing = ''
    const progress = (node: PMNode | null, _offset: number, index: number) => {
      let marks: readonly Mark[] = node ? node.marks : []
      if (node && node.type.name === 'hard_break') {
        marks = marks.filter(m => {
          if (index + 1 === parent.childCount) return false
          const next = parent.child(index + 1)
          return m.isInSet(next.marks) && (!next.isText || /\S/.test(next.text!))
        })
      }
      let leading = trailing
      trailing = ''
      if (node && node.isText && marks.some(m => EXPEL.has(m.type.name) && !m.isInSet(active))) {
        const [, lead, rest] = /^(\s*)([\s\S]*)$/.exec(node.text!)!
        if (lead) {
          leading += lead
          node = rest ? (node as any).withText(rest) : null
          if (!node) marks = active
        }
      }
      if (node && node.isText && marks.some(m => EXPEL.has(m.type.name) &&
        (index === parent.childCount - 1 || !m.isInSet(parent.child(index + 1).marks)))) {
        const [, rest, trail] = /^([\s\S]*?)(\s*)$/.exec(node.text!)!
        if (trail) {
          trailing = trail
          node = rest ? (node as any).withText(rest) : null
          if (!node) marks = active
        }
      }
      const inner = marks.length ? marks[marks.length - 1] : null
      const noEsc = !!inner && inner.type.name === 'code'
      const len = marks.length - (noEsc ? 1 : 0)
      // Keep the still-open marks in their current nesting order and open the
      // new ones outermost-first by how far they extend (so `[*a* b](u)` and
      // `***a* b**` come out right).
      const rest = marks.slice(0, len)
      let ms: Mark[] = []
      for (const a of active) {
        if (rest.some(m => m.eq(a))) ms.push(a)
        else break
      }
      const extent = (m: Mark) => {
        let n = 0
        for (let i = index; i < parent.childCount && m.isInSet(parent.child(i).marks); i++) n++
        return n
      }
      const fresh = rest.filter(m => !ms.some(a => a.eq(m)))
      fresh.sort((x, y) => extent(y) - extent(x))
      ms = ms.concat(fresh)
      if (noEsc) ms.push(inner!)
      let keep = 0
      while (keep < Math.min(active.length, len) && ms[keep].eq(active[keep])) ++keep
      while (keep < active.length) { this.out += this.markClose(active.pop()!, parent, index); }
      if (leading) this.text(leading, true)
      if (node) {
        while (active.length < len) {
          const add = ms[active.length]
          active.push(add)
          this.out += this.markOpen(add, parent, index)
          this.atStart = false
        }
        if (noEsc && node.isText) {
          const t = this.opts.mode === 'para' || this.opts.mode === 'setext' ? node.text! : node.text!.replace(/\n/g, ' ')
          this.out += this.markOpen(inner!, parent, index) + (this.opts.mode === 'cell' ? t.replace(/\|/g, '\\|') : t) +
            this.markClose(inner!, parent, index + 1)
          this.atStart = false
        } else {
          this.node(node, parent, index)
        }
      }
    }
    parent.forEach(progress)
    progress(null, 0, parent.childCount)
  }
}

function renderInline(node: PMNode, ctx: SerializeCtx, opts: InlineOpts): string {
  const w = new InlineWriter(ctx, opts)
  w.render(node)
  return w.out
}

function inlineFromParse(tokens: any[], wantType: string, level?: number): Fragment | null {
  if (tokens.length !== 3 || tokens[0].type !== wantType + '_open' || tokens[1].type !== 'inline') return null
  if (level !== undefined && tokens[0].tag !== 'h' + level) return null
  return nodesToFragment(tokens[1].children)
}

function nodesToFragment(children: any[]): Fragment {
  const para = tokensToNodes([
    { type: 'paragraph_open', map: null },
    { type: 'inline', children },
    { type: 'paragraph_close' },
  ]).nodes[0]
  return para ? para.content : Fragment.empty
}

function sameInline(a: Fragment, b: Fragment): boolean {
  return a.eq(b)
}

function verify(node: PMNode, text: string, mode: InlineMode, ctx: SerializeCtx): boolean {
  const env: ParseEnv = { references: ctx.env.references, footnotes: { ...(ctx.env.footnotes || {}) } }
  let expect = node.content
  if (mode === 'atx' || mode === 'cell') {
    // soft breaks were flattened to spaces
    const flat: PMNode[] = []
    node.content.forEach(n => {
      if (n.isText) flat.push((n as any).withText(n.text!.replace(/\n/g, ' ')))
      else if (n.type.name === 'hard_break' && mode === 'atx') flat.push(schema.text(' ', n.marks))
      else flat.push(n)
    })
    expect = Fragment.fromArray(flat)
    // trailing hard breaks are dropped by the serializer
  }
  expect = trimEdges(stripTrailingBreaks(expect))
  if (mode === 'para') {
    const toks = md.parse(text, env)
    const got = inlineFromParse(toks, 'paragraph')
    return !!got && sameInline(stripTrailingBreaks(got), expect)
  }
  if (mode === 'atx' || mode === 'setext') {
    const src = mode === 'atx' ? '#'.repeat(node.attrs.level) + ' ' + text : text + '\n' + (node.attrs.level === 1 ? '===' : '---')
    const toks = md.parse(src, env)
    const got = inlineFromParse(toks, 'heading', node.attrs.level)
    return !!got && sameInline(stripTrailingBreaks(got), expect)
  }
  const toks = md.parseInline(text, env)
  const children = toks[0]?.children || []
  return sameInline(nodesToFragment(children), expect)
}

/** Whitespace markdown cannot keep: at the ends of the block and around soft breaks. */
function trimEdges(f: Fragment): Fragment {
  const arr: PMNode[] = []
  f.forEach(n => arr.push(n))
  const fix = (i: number, fn: (t: string) => string) => {
    const n = arr[i]
    if (!n || !n.isText) return
    const t = fn(n.text!)
    if (t) arr[i] = (n as any).withText(t)
    else arr.splice(i, 1)
  }
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].isText && /[ \t]\n|\n[ \t]/.test(arr[i].text!)) fix(i, t => t.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n'))
  }
  fix(arr.length - 1, t => t.replace(/[ \t]+$/, ''))
  fix(0, t => t.replace(/^[ \t]+/, ''))
  return Fragment.fromArray(arr)
}

function stripTrailingBreaks(f: Fragment): Fragment {
  let n = f.childCount
  while (n > 0 && f.child(n - 1).type.name === 'hard_break') n--
  if (n === f.childCount) return f
  const arr: PMNode[] = []
  for (let i = 0; i < n; i++) arr.push(f.child(i))
  return Fragment.fromArray(arr)
}

const ATTEMPTS: Omit<InlineOpts, 'mode'>[] = [
  { esc: 'min', star: false },
  { esc: 'min', star: true },
  { esc: 'cons', star: true },
]

export function inlineMarkdown(node: PMNode, ctx: SerializeCtx, mode: InlineMode): string {
  if (!node.childCount) return ''
  let last = ''
  for (const a of ATTEMPTS) {
    last = renderInline(node, ctx, { ...a, mode }).replace(/[ \t]+$/, '')
    let ok = false
    try { ok = verify(node, last, mode, ctx) } catch { ok = false }
    if (ok) return last
  }
  return last
}

// ------------------------------------------------------------------ blocks

const EAST_ASIAN_WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

export function strWidth(s: string): number {
  let w = 0
  for (const ch of s) w += EAST_ASIAN_WIDE.test(ch) ? 2 : 1
  return w
}

class BlockWriter {
  out = ''
  delim = ''
  closed: PMNode | null = null
  inTightList = false

  constructor(public ctx: SerializeCtx) {}

  flushClose(size = 2) {
    if (this.closed) {
      if (!this.atBlank()) this.out += '\n'
      if (size > 1) {
        const delimMin = this.delim.replace(/\s+$/, '')
        for (let i = 1; i < size; i++) this.out += delimMin + '\n'
      }
      this.closed = null
    }
  }

  atBlank() {
    return /(^|\n)$/.test(this.out)
  }

  ensureNewLine() {
    if (!this.atBlank()) this.out += '\n'
  }

  write(content?: string) {
    this.flushClose()
    if (this.delim && this.atBlank()) this.out += this.delim
    if (content) this.out += content
  }

  /** Write raw multi-line text, prefixing every line with the current delimiter. */
  lines(text: string) {
    const ls = text.split('\n')
    for (let i = 0; i < ls.length; i++) {
      this.write()
      if (!ls[i] && i > 0) {
        // keep blank lines inside containers tidy (no trailing spaces)
        this.out = this.out.replace(/[ \t]+$/, '')
      }
      this.out += ls[i]
      if (i !== ls.length - 1) this.out += '\n'
    }
  }

  closeBlock(node: PMNode) {
    this.closed = node
  }

  wrapBlock(delim: string, firstDelim: string | null, node: PMNode, f: () => void) {
    const old = this.delim
    this.write(firstDelim ?? delim)
    this.delim += delim
    f()
    this.delim = old
    this.closeBlock(node)
  }

  renderContent(parent: PMNode) {
    parent.forEach((child, _, i) => this.render(child, parent, i))
  }

  renderList(node: PMNode, marker: (i: number) => string) {
    if (this.inTightList) this.flushClose(1)
    const tight = !!node.attrs.tight
    const prevTight = this.inTightList
    this.inTightList = tight
    node.forEach((child, _, i) => {
      if (i && tight) this.flushClose(1)
      const m = marker(i)
      this.wrapBlock(' '.repeat(m.length), m, node, () => this.render(child, node, i))
    })
    this.inTightList = prevTight
  }

  render(node: PMNode, parent: PMNode | null, index: number) {
    const ctx = this.ctx
    const prev = parent && index > 0 ? parent.child(index - 1) : null
    switch (node.type.name) {
      case 'paragraph': {
        const s = inlineMarkdown(node, ctx, 'para')
        this.write()
        this.lines(s)
        this.closeBlock(node)
        break
      }
      case 'heading': {
        const level = node.attrs.level
        if (node.attrs.setext && level <= 2 && node.childCount) {
          const s = inlineMarkdown(node, ctx, 'setext')
          this.write()
          this.lines(s)
          this.out += '\n'
          const lastLine = s.split('\n').pop() || ''
          this.write((level === 1 ? '=' : '-').repeat(Math.max(3, strWidth(lastLine))))
        } else {
          // a trailing run of # would be read as the closing sequence
          const s = inlineMarkdown(node, ctx, 'atx').replace(/(^|[ \t])(#+)([ \t]*)$/, '$1\\$2$3')
          this.write('#'.repeat(level) + (s ? ' ' + s : ''))
        }
        this.closeBlock(node)
        break
      }
      case 'blockquote':
        this.wrapBlock('> ', null, node, () => this.renderContent(node))
        break
      case 'callout': {
        const { kind, fold, title } = node.attrs
        this.wrapBlock('> ', null, node, () => {
          this.out += `[!${kind}]${fold || ''}${title ? ' ' + title : ''}`
          if (node.childCount) {
            if (node.firstChild!.type.name === 'paragraph') this.out += '\n'
            else this.closeBlock(node)
            this.renderContent(node)
          }
        })
        break
      }
      case 'code_block': {
        const text = node.textContent
        const afterList = !!prev && /list$/.test(prev.type.name)
        if (node.attrs.indented && !node.attrs.info && text.trim() && !afterList && !(parent && parent.type.name === 'list_item' && index === 0)) {
          this.wrapBlock('    ', null, node, () => this.lines(text))
          break
        }
        let ch = (node.attrs.fence || '```')[0] === '~' ? '~' : '`'
        const info = node.attrs.info || ''
        if (ch === '`' && info.includes('`')) ch = '~'
        let len = Math.max(3, (node.attrs.fence || '').length)
        const re = new RegExp('^ {0,3}(' + (ch === '`' ? '`' : '~') + '{3,})', 'gm')
        let m
        while ((m = re.exec(text))) len = Math.max(len, m[1].length + 1)
        const fence = ch.repeat(len)
        this.write(fence + info)
        this.out += '\n'
        if (text) { this.lines(text); this.out += '\n' }
        this.write(fence)
        this.closeBlock(node)
        break
      }
      case 'math_block': {
        const text = node.textContent
        this.write('$$')
        this.out += '\n'
        if (text) { this.lines(text); this.out += '\n' }
        this.write('$$')
        this.closeBlock(node)
        break
      }
      case 'html_block':
      case 'ref_def':
        this.write()
        this.lines(node.textContent)
        this.closeBlock(node)
        break
      case 'frontmatter': {
        const text = node.textContent
        this.write('---')
        this.out += '\n'
        if (text) { this.lines(text); this.out += '\n' }
        this.write('---')
        this.closeBlock(node)
        break
      }
      case 'horizontal_rule': {
        let mk = node.attrs.markup || '---'
        if (mk.length < 3) mk = mk[0].repeat(3)
        this.write(mk)
        this.closeBlock(node)
        break
      }
      case 'toc':
        this.write(node.attrs.markup || '[TOC]')
        this.closeBlock(node)
        break
      case 'bullet_list': {
        let bullet = node.attrs.bullet || '-'
        if (prev && prev.type === node.type && (prev.attrs.bullet || '-') === bullet) bullet = bullet === '-' ? '*' : '-'
        this.renderList(node, () => bullet + ' ')
        break
      }
      case 'ordered_list': {
        const start = node.attrs.order ?? 1
        let delim = node.attrs.delim || '.'
        if (prev && prev.type === node.type && (prev.attrs.delim || '.') === delim) delim = delim === '.' ? ')' : '.'
        this.renderList(node, i => String(node.attrs.same ? start : start + i) + delim + ' ')
        break
      }
      case 'list_item': {
        const checked = node.attrs.checked
        if (checked != null && node.firstChild?.type.name === 'paragraph') {
          this.out += checked ? '[x] ' : '[ ] '
        }
        // blocks of a tight item are separated by a plain newline
        node.forEach((child, _, i) => {
          if (i && this.inTightList) this.flushClose(1)
          this.render(child, node, i)
        })
        break
      }
      case 'footnote_def':
        this.wrapBlock('    ', `[^${node.attrs.label}]: `, node, () => this.renderContent(node))
        break
      case 'table':
        this.table(node)
        break
      default:
        // unknown / inline-at-block-level: best effort
        if (node.isTextblock) {
          this.write()
          this.lines(inlineMarkdown(node, ctx, 'para'))
          this.closeBlock(node)
        }
    }
  }

  table(node: PMNode) {
    const rows: string[][] = []
    const aligns: (string | null)[] = []
    node.forEach((row, _, r) => {
      const cells: string[] = []
      row.forEach((cell, _, c) => {
        cells.push(inlineMarkdown(cell, this.ctx, 'cell').trim())
        if (r === 0) aligns[c] = cell.attrs.align
      })
      rows.push(cells)
    })
    const ncols = Math.max(1, ...rows.map(r => r.length))
    for (const r of rows) while (r.length < ncols) r.push('')
    const widths: number[] = []
    for (let c = 0; c < ncols; c++) widths[c] = Math.max(3, ...rows.map(r => strWidth(r[c])))
    const pad = (s: string, c: number) => {
      const gap = widths[c] - strWidth(s)
      if (gap <= 0) return s
      if (aligns[c] === 'right') return ' '.repeat(gap) + s
      if (aligns[c] === 'center') return ' '.repeat(gap >> 1) + s + ' '.repeat(gap - (gap >> 1))
      return s + ' '.repeat(gap)
    }
    const line = (cells: string[]) => '| ' + cells.map((s, c) => pad(s, c)).join(' | ') + ' |'
    const sep = '| ' + widths.map((w, c) => {
      const a = aligns[c]
      if (a === 'center') return ':' + '-'.repeat(w - 2) + ':'
      if (a === 'right') return '-'.repeat(w - 1) + ':'
      if (a === 'left') return ':' + '-'.repeat(w - 1)
      return '-'.repeat(w)
    }).join(' | ') + ' |'
    const out = [line(rows[0] || []), sep, ...rows.slice(1).map(line)]
    this.write()
    this.lines(out.join('\n'))
    this.closeBlock(node)
  }
}

/** Serialize one block node (top-level) to markdown with '\n' line endings, no trailing newline. */
export function serializeBlock(node: PMNode, ctx: SerializeCtx, prev: PMNode | null = null): string {
  const w = new BlockWriter(ctx)
  if (prev) {
    const fake = schema.nodes.doc.create(null, [prev, node])
    w.render(node, fake, 1)
  } else {
    w.render(node, null, 0)
  }
  return w.out.replace(/\s+$/, m => (m.includes('\n') ? '' : m)).replace(/\n+$/, '')
}

/** Serialize a sequence of blocks (e.g. a clipboard slice). */
export function serializeNodes(nodes: PMNode[], ctx: SerializeCtx): string {
  const parts: string[] = []
  let prev: PMNode | null = null
  for (const n of nodes) {
    const s = serializeBlock(n, ctx, prev)
    if (s) parts.push(s)
    prev = n
  }
  return parts.join('\n\n')
}
