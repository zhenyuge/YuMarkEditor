// markdown-it instance with the extensions YuMarkEditor understands.
// Every block-level token we add carries a `map` so the editor can write
// untouched blocks back byte-for-byte.
import MarkdownIt from 'markdown-it'

type State = any
type Token = any

const isSpace = (c: number) => c === 0x20 || c === 0x09

// ---------------------------------------------------------------- frontmatter
function frontMatter(state: State, startLine: number, endLine: number, silent: boolean) {
  if (startLine !== 0 || state.blkIndent !== 0 || state.parentType !== 'root') return false
  const lineText = (n: number) => state.src.slice(state.bMarks[n], state.eMarks[n])
  if (lineText(0).replace(/[ \t]+$/, '') !== '---') return false
  let close = -1
  for (let n = 1; n < endLine; n++) {
    const t = lineText(n).replace(/[ \t]+$/, '')
    if (t === '---' || t === '...') { close = n; break }
  }
  if (close < 0) return false
  if (silent) return true
  const tok = state.push('front_matter', '', 0)
  tok.block = true
  tok.markup = '---'
  tok.map = [0, close + 1]
  tok.content = close > 1 ? state.src.slice(state.bMarks[1], state.eMarks[close - 1]) : ''
  state.line = close + 1
  return true
}

// ---------------------------------------------------------------- <svg> blocks
// CommonMark only treats a handful of tags as block HTML; an <svg> on its own
// line should render as a picture, not as inline tags inside a paragraph.
function svgBlock(state: State, startLine: number, endLine: number, silent: boolean) {
  const pos = state.bMarks[startLine] + state.tShift[startLine]
  if (state.sCount[startLine] - state.blkIndent >= 4) return false
  if (!/^<svg[\s>]/i.test(state.src.slice(pos, pos + 5))) return false
  let next = startLine
  for (; next < endLine; next++) {
    const line = state.src.slice(state.bMarks[next], state.eMarks[next])
    if (next > startLine && !line.trim()) { next--; break }
    if (/<\/svg>/i.test(line)) break
  }
  if (next >= endLine) next = endLine - 1
  if (silent) return true
  const tok = state.push('html_block', '', 0)
  tok.map = [startLine, next + 1]
  tok.content = state.getLines(startLine, next + 1, state.blkIndent, true)
  state.line = next + 1
  return true
}

// ---------------------------------------------------------------- $$ math $$
function mathBlock(state: State, startLine: number, endLine: number, silent: boolean) {
  let pos = state.bMarks[startLine] + state.tShift[startLine]
  let max = state.eMarks[startLine]
  if (state.sCount[startLine] - state.blkIndent >= 4) return false
  if (pos + 2 > max || state.src.slice(pos, pos + 2) !== '$$') return false
  const first = state.src.slice(pos + 2, max)
  let content: string
  let next = startLine
  const firstTrim = first.trim()
  if (firstTrim.length >= 2 && firstTrim.endsWith('$$')) {
    content = firstTrim.slice(0, -2)
  } else {
    let found = false
    let last = ''
    for (next = startLine + 1; next < endLine; next++) {
      pos = state.bMarks[next] + state.tShift[next]
      max = state.eMarks[next]
      if (pos < max && state.sCount[next] < state.blkIndent) break
      const line = state.src.slice(pos, max).replace(/[ \t]+$/, '')
      if (line.endsWith('$$')) { last = line.slice(0, -2); found = true; break }
    }
    if (!found) return false
    const middle = next > startLine + 1 ? state.getLines(startLine + 1, next, state.blkIndent, true) : ''
    content = (firstTrim ? firstTrim + '\n' : '') + middle + (last.trim() ? last : '')
    content = content.replace(/\n$/, '')
  }
  if (silent) return true
  const tok = state.push('math_block', 'math', 0)
  tok.block = true
  tok.markup = '$$'
  tok.content = content
  tok.map = [startLine, next + 1]
  state.line = next + 1
  return true
}

// ---------------------------------------------------------------- $math$
function mathInline(state: State, silent: boolean) {
  const src: string = state.src
  const start = state.pos
  if (src.charCodeAt(start) !== 0x24) return false
  const markup = src.charCodeAt(start + 1) === 0x24 ? '$$' : '$'
  const afterOpen = start + markup.length
  if (afterOpen >= state.posMax) return false
  const nextCh = src.charCodeAt(afterOpen)
  if (markup === '$' && (isSpace(nextCh) || nextCh === 0x0a)) return false
  let pos = afterOpen
  for (;;) {
    pos = src.indexOf(markup, pos)
    if (pos < 0 || pos + markup.length > state.posMax) return false
    let bs = pos - 1, n = 0
    while (bs >= afterOpen && src.charCodeAt(bs) === 0x5c) { bs--; n++ }
    if (n % 2 === 1) { pos++; continue }
    if (markup === '$') {
      const prev = src.charCodeAt(pos - 1)
      if (isSpace(prev) || prev === 0x0a) { pos++; continue }
      const after = src.charCodeAt(pos + 1)
      if (after >= 0x30 && after <= 0x39) { pos++; continue }
    }
    break
  }
  if (pos === afterOpen) return false
  if (!silent) {
    const tok = state.push('math_inline', 'math', 0)
    tok.markup = markup
    tok.content = src.slice(afterOpen, pos)
  }
  state.pos = pos + markup.length
  return true
}

// ---------------------------------------------------------------- footnotes
// Unlike markdown-it-footnote, definitions stay where they are written.
function footnoteDef(state: State, startLine: number, endLine: number, silent: boolean) {
  const start = state.bMarks[startLine] + state.tShift[startLine]
  const max = state.eMarks[startLine]
  if (state.sCount[startLine] - state.blkIndent >= 4) return false
  if (start + 4 > max) return false
  if (state.src.charCodeAt(start) !== 0x5b || state.src.charCodeAt(start + 1) !== 0x5e) return false
  let pos
  for (pos = start + 2; pos < max; pos++) {
    const c = state.src.charCodeAt(pos)
    if (c === 0x20) return false
    if (c === 0x5d) break
  }
  if (pos === start + 2) return false
  if (pos + 1 >= max || state.src.charCodeAt(++pos) !== 0x3a) return false
  if (silent) return true
  pos++
  const label = state.src.slice(start + 2, pos - 2)
  state.env.footnotes ??= {}
  state.env.footnotes[label] = true

  const open = new state.Token('footnote_def_open', '', 1)
  open.meta = { label }
  open.block = true
  open.level = state.level++
  state.tokens.push(open)

  const oldBMark = state.bMarks[startLine]
  const oldTShift = state.tShift[startLine]
  const oldSCount = state.sCount[startLine]
  const oldParentType = state.parentType
  const posAfterColon = pos
  const initial = state.sCount[startLine] + pos - (state.bMarks[startLine] + state.tShift[startLine])
  let offset = initial
  while (pos < max) {
    const ch = state.src.charCodeAt(pos)
    if (!isSpace(ch)) break
    offset += ch === 0x09 ? 4 - (offset % 4) : 1
    pos++
  }
  state.tShift[startLine] = pos - posAfterColon
  state.sCount[startLine] = offset - initial
  state.bMarks[startLine] = posAfterColon
  state.blkIndent += 4
  state.parentType = 'footnote'
  if (state.sCount[startLine] < state.blkIndent) state.sCount[startLine] += state.blkIndent
  state.md.block.tokenize(state, startLine, endLine, true)
  state.parentType = oldParentType
  state.blkIndent -= 4
  state.tShift[startLine] = oldTShift
  state.sCount[startLine] = oldSCount
  state.bMarks[startLine] = oldBMark
  open.map = [startLine, state.line]

  const close = new state.Token('footnote_def_close', '', -1)
  close.block = true
  close.level = --state.level
  state.tokens.push(close)
  return true
}

function footnoteRef(state: State, silent: boolean) {
  const max = state.posMax
  const start = state.pos
  if (start + 3 > max) return false
  if (!state.env.footnotes) return false
  if (state.src.charCodeAt(start) !== 0x5b || state.src.charCodeAt(start + 1) !== 0x5e) return false
  let pos
  for (pos = start + 2; pos < max; pos++) {
    const c = state.src.charCodeAt(pos)
    if (c === 0x20 || c === 0x0a) return false
    if (c === 0x5d) break
  }
  if (pos === start + 2 || pos >= max) return false
  pos++
  const label = state.src.slice(start + 2, pos - 1)
  if (!state.env.footnotes[label]) return false
  if (!silent) {
    const tok = state.push('footnote_ref', '', 0)
    tok.meta = { label }
  }
  state.pos = pos
  return true
}

// ---------------------------------------------------------------- [label]: url
// markdown-it swallows reference definitions without emitting a token. We emit
// one so they survive as their own (verbatim) block.
function wrapReference(md: any) {
  const rules = (md.block.ruler as any).__rules__ as { name: string; fn: any }[]
  const orig = rules.find(r => r.name === 'reference')!.fn
  md.block.ruler.at('reference', (state: State, startLine: number, endLine: number, silent: boolean) => {
    const before = state.tokens.length
    const ok = orig(state, startLine, endLine, silent)
    if (ok && !silent && state.tokens.length === before) {
      const tok = state.push('ref_def', '', 0)
      tok.block = true
      tok.map = [startLine, state.line]
      tok.content = state.getLines(startLine, state.line, state.blkIndent, false).replace(/\n$/, '')
    }
    return ok
  })
}

// ---------------------------------------------------------------- > [!NOTE]
const CALLOUT_RE = /^\[!([A-Za-z][\w-]*)\]([+-]?)(?:[ \t]+(.*))?$/

function callouts(state: State) {
  const tokens: Token[] = state.tokens
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'blockquote_open') continue
    const p = tokens[i + 1], inl = tokens[i + 2]
    if (!p || p.type !== 'paragraph_open' || !inl || inl.type !== 'inline') continue
    const nl = inl.content.indexOf('\n')
    const firstLine = nl < 0 ? inl.content : inl.content.slice(0, nl)
    const m = CALLOUT_RE.exec(firstLine.trim())
    if (!m) continue
    t.type = 'callout_open'
    t.meta = { kind: m[1], fold: m[2] || '', title: (m[3] || '').trim() }
    let depth = 0
    for (let j = i; j < tokens.length; j++) {
      if (tokens[j].type === 'blockquote_open' || tokens[j].type === 'callout_open') depth++
      else if (tokens[j].type === 'blockquote_close') {
        if (--depth === 0) { tokens[j].type = 'callout_close'; break }
      }
    }
    if (nl < 0) tokens.splice(i + 1, 3)
    else inl.content = inl.content.slice(nl + 1)
  }
}

// ---------------------------------------------------------------- [TOC]
function toc(state: State) {
  const tokens: Token[] = state.tokens
  for (let i = 0; i < tokens.length - 2; i++) {
    const t = tokens[i]
    if (t.type !== 'paragraph_open' || tokens[i + 1].type !== 'inline') continue
    const c = tokens[i + 1].content.trim()
    if (!/^\[toc\]$/i.test(c)) continue
    const tok = new state.Token('toc', '', 0)
    tok.block = true
    tok.map = t.map
    tok.level = t.level
    tok.markup = c
    tokens.splice(i, 3, tok)
  }
}

// ---------------------------------------------------------------- - [ ] task
const TASK_RE = /^\[([ xX])\](?=\s|$)/

function taskLists(state: State) {
  const tokens: Token[] = state.tokens
  for (let i = 0; i < tokens.length - 2; i++) {
    if (tokens[i].type !== 'list_item_open') continue
    const p = tokens[i + 1], inl = tokens[i + 2]
    if (p.type !== 'paragraph_open' || inl.type !== 'inline') continue
    const m = TASK_RE.exec(inl.content)
    if (!m) continue
    const first = inl.children?.[0]
    if (!first || first.type !== 'text' || !TASK_RE.test(first.content)) continue
    tokens[i].meta = { ...(tokens[i].meta || {}), checked: m[1] !== ' ' }
    first.content = first.content.slice(3).replace(/^[ \t]/, '')
    if (!first.content) inl.children.shift()
    inl.content = inl.content.slice(3).replace(/^[ \t]/, '')
  }
}

export function createMarkdown(): any {
  const md = new MarkdownIt('default', { html: true, linkify: true, typographer: false, breaks: false })
  md.linkify.set({ fuzzyEmail: false })
  md.block.ruler.before('table', 'front_matter', frontMatter)
  md.block.ruler.before('html_block', 'svg_block', svgBlock, { alt: ['paragraph', 'reference', 'blockquote'] })
  md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
  md.block.ruler.before('reference', 'footnote_def', footnoteDef, { alt: ['paragraph', 'reference'] })
  wrapReference(md)
  md.inline.ruler.after('escape', 'math_inline', mathInline)
  md.inline.ruler.after('image', 'footnote_ref', footnoteRef)
  md.core.ruler.after('block', 'callouts', callouts)
  md.core.ruler.after('callouts', 'toc', toc)
  md.core.ruler.push('task_lists', taskLists)
  return md
}

export const md = createMarkdown()

export interface ParseEnv {
  references?: Record<string, { href: string; title: string }>
  footnotes?: Record<string, true>
}
