// Markdown -> DOCX (Office Open XML, transitional) export.
//
// Pipeline: markdown-it tokens (the project's own instance, so every YuMarkEditor
// extension is understood) -> Block[] (paragraph properties + run XML) ->
// WordprocessingML parts -> zip (fflate).
//
// Everything asynchronous (images, mermaid) is resolved up front, so the
// render is one synchronous walk in document order. That order is also the
// order Word numbers footnotes in, which is how footnote ids are assigned.

import { strToU8, zipSync, type Zippable } from 'fflate'
import { mml2omml } from 'mathml2omml'
import { md } from '../md/markdown'
import { calloutKind, CALLOUT_LABEL } from '../icons'

export interface DocxImage { data: Uint8Array; mime: 'image/png' | 'image/jpeg' | 'image/gif'; width: number; height: number } // width/height in px

export interface DocxOptions {
  title?: string
  /** resolve an image src (as written in the markdown) to bytes; null = skip image, emit alt text instead */
  loadImage(src: string): Promise<DocxImage | null>
  /** LaTeX -> MathML string (e.g. KaTeX output:'mathml'); null if it fails */
  mathToMathML(tex: string, display: boolean): string | null
  /** mermaid source -> PNG; null = emit the code as a code block instead */
  mermaidToPng(code: string): Promise<DocxImage | null>
}

export async function markdownToDocx(markdown: string, opts: DocxOptions): Promise<Uint8Array> {
  return new DocxWriter(opts).convert(markdown)
}

type Token = ReturnType<typeof md.parse>[number]

// ------------------------------------------------------------------ constants
const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
}
const PART_NS = Object.entries(NS).map(([p, u]) => `xmlns:${p}="${u}"`).join(' ')
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'

const PAGE_W = 11906, PAGE_H = 16838, MARGIN = 1440 // A4, 1in margins (twips)
const TEXT_W = PAGE_W - 2 * MARGIN
const TWIP_EMU = 635, PX_EMU = 9525
const MAX_IMG_W = Math.round(6.3 * 914400)
const MAX_IMG_H = Math.round(9 * 914400)

const LIST_INDENT = 720 // text indent added per list level
const LIST_HANG = 360   // number/bullet sits this far left of the text
const QUOTE_INDENT = 360
const CODE_PAD = 115
const BULLET_NUM = 1
const BULLETS = ['•', '◦', '▪']
const ORDERED_FMT = ['decimal', 'lowerLetter', 'lowerRoman']

const FONT = { latin: 'Calibri', eastAsia: '等线', code: 'Menlo', symbol: 'Segoe UI Symbol' }
const COLOR = {
  text: '1F2328', muted: '59636E', rule: 'D0D7DE', codeBg: 'F6F8FA', inlineBg: 'EFF1F3',
  link: '0563C1', headBg: 'F2F4F7', grid: 'BFC5CC',
}
const MIME_EXT: Record<DocxImage['mime'], string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif' }

function calloutColors(kind: string): { color: string; fill: string } {
  const k = kind.toLowerCase()
  if (/^(tip|hint|success|check|done)$/.test(k)) return { color: '1A7F37', fill: 'EAF6EC' }
  if (/^(important|example)$/.test(k)) return { color: '8250DF', fill: 'F3EFFD' }
  if (/^(warning|attention|question|help|faq)$/.test(k)) return { color: 'BF6A02', fill: 'FFF5E5' }
  if (/^(caution|danger|error|failure|fail|missing|bug)$/.test(k)) return { color: 'CF222E', fill: 'FFEBE9' }
  if (/^(quote|cite)$/.test(k)) return { color: '818B98', fill: 'F6F8FA' }
  return { color: '0969DA', fill: 'EAF3FF' } // note, info, todo, abstract, summary, tldr, unknown
}

// ------------------------------------------------------------------ xml text
// Keep valid surrogate pairs, drop lone surrogates and chars XML 1.0 forbids.
const BAD_XML = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF￾￿]/g
const clean = (s: string) => s.replace(BAD_XML, c => (c.length === 2 ? c : ''))
const esc = (s: string) =>
  clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', middot: '·', times: '×',
}
function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][\da-fA-F]+|#\d+|[A-Za-z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      try { return String.fromCodePoint(cp) } catch { return m }
    }
    return NAMED_ENTITIES[e] ?? m
  })
}

// ------------------------------------------------------------------ runs
interface RP {
  style?: string
  font?: 'code' | 'symbol'
  b?: boolean; i?: boolean; strike?: boolean; u?: boolean; hl?: boolean
  color?: string; sz?: number; shd?: string
  va?: 'superscript' | 'subscript'
}

function rPr(p: RP): string {
  let s = ''
  if (p.style) s += `<w:rStyle w:val="${p.style}"/>`
  if (p.font) {
    const f = p.font === 'code' ? FONT.code : FONT.symbol
    s += `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/>`
  }
  if (p.b) s += '<w:b/><w:bCs/>'
  if (p.i) s += '<w:i/><w:iCs/>'
  if (p.strike) s += '<w:strike/>'
  if (p.font === 'code') s += '<w:noProof/>'
  if (p.color) s += `<w:color w:val="${p.color}"/>`
  if (p.sz) s += `<w:sz w:val="${p.sz}"/><w:szCs w:val="${p.sz}"/>`
  if (p.hl) s += '<w:highlight w:val="yellow"/>'
  if (p.u) s += '<w:u w:val="single"/>'
  if (p.shd) s += `<w:shd w:val="clear" w:color="auto" w:fill="${p.shd}"/>`
  if (p.va) s += `<w:vertAlign w:val="${p.va}"/>`
  return s ? `<w:rPr>${s}</w:rPr>` : ''
}

/** One run; tabs become <w:tab/>, newlines <w:br/>. */
function runs(text: string, p: RP = {}): string {
  let inner = ''
  for (const part of text.replace(/\r\n?/g, '\n').split(/(\t|\n)/)) {
    if (part === '\t') inner += '<w:tab/>'
    else if (part === '\n') inner += '<w:br/>'
    else if (part) inner += `<w:t xml:space="preserve">${esc(part)}</w:t>`
  }
  return inner ? `<w:r>${rPr(p)}${inner}</w:r>` : ''
}

const BR = '<w:r><w:br/></w:r>'

// ------------------------------------------------------------------ paragraphs
interface Bdr { color: string; sz: number; space: number }
interface PProps {
  style?: string
  keepNext?: boolean
  numId?: number; ilvl?: number
  bar?: Bdr      // left border (quote / callout bar)
  bottom?: Bdr
  shd?: string
  tabs?: number[]
  before?: number; after?: number; line?: number
  left?: number; right?: number; hanging?: number
  contextual?: boolean
  jc?: 'left' | 'center' | 'right'
  markSz?: number
}

const border = (side: string, b: Bdr) => `<w:${side} w:val="single" w:sz="${b.sz}" w:space="${b.space}" w:color="${b.color}"/>`

/** <w:pPr>, children in the order the schema requires. */
function pPr(p: PProps): string {
  let s = ''
  if (p.style) s += `<w:pStyle w:val="${p.style}"/>`
  if (p.keepNext) s += '<w:keepNext/>'
  if (p.numId != null) s += `<w:numPr><w:ilvl w:val="${p.ilvl ?? 0}"/><w:numId w:val="${p.numId}"/></w:numPr>`
  if (p.bar || p.bottom) s += `<w:pBdr>${p.bar ? border('left', p.bar) : ''}${p.bottom ? border('bottom', p.bottom) : ''}</w:pBdr>`
  if (p.shd) s += `<w:shd w:val="clear" w:color="auto" w:fill="${p.shd}"/>`
  if (p.tabs?.length) s += `<w:tabs>${p.tabs.map(pos => `<w:tab w:val="left" w:pos="${pos}"/>`).join('')}</w:tabs>`
  if (p.before != null || p.after != null || p.line != null) {
    s += '<w:spacing'
      + (p.before != null ? ` w:before="${p.before}"` : '')
      + (p.after != null ? ` w:after="${p.after}"` : '')
      + (p.line != null ? ` w:line="${p.line}" w:lineRule="auto"` : '')
      + '/>'
  }
  if (p.left != null || p.right != null || p.hanging) {
    s += '<w:ind'
      + (p.left != null ? ` w:left="${p.left}"` : '')
      + (p.right != null ? ` w:right="${p.right}"` : '')
      + (p.hanging ? ` w:hanging="${p.hanging}"` : '')
      + '/>'
  }
  if (p.contextual != null) s += p.contextual ? '<w:contextualSpacing/>' : '<w:contextualSpacing w:val="0"/>'
  if (p.jc) s += `<w:jc w:val="${p.jc}"/>`
  if (p.markSz) s += `<w:rPr><w:sz w:val="${p.markSz}"/><w:szCs w:val="${p.markSz}"/></w:rPr>`
  return s ? `<w:pPr>${s}</w:pPr>` : ''
}

type Block = { kind: 'p'; pp: PProps; body: string } | { kind: 'tbl'; xml: string }

// ------------------------------------------------------------------ contexts
interface Rel { id: string; type: string; target: string; external: boolean }
interface Part { base: number; rels: Rel[]; ids: Map<string, string> }
const newPart = (base: number): Part => ({ base, rels: [], ids: new Map() })

interface ListItem {
  numId: number; ilvl: number; left: number
  task?: boolean
  bulletTask: boolean // task in a bullet list: the checkbox replaces the bullet
  used: boolean       // the item's first paragraph (which carries the number) was emitted
}

/** block context */
interface Cx {
  part: Part
  footnote: boolean
  container: 'root' | 'quote' | 'callout' | 'item'
  indent: number                                  // left text indent, twips
  bar?: { color: string; sz: number; pos: number } // left rule of the enclosing quote/callout
  fill?: string                                    // callout shading
  listDepth: number
  item?: ListItem
  tight: boolean
}

/** inline context */
interface Ix { part: Part; footnote: boolean; base: RP; codeSz?: number; maxImg: number }

function closeOf(ts: Token[], i: number): number {
  let depth = 0
  for (let j = i; j < ts.length; j++) {
    depth += ts[j].nesting
    if (depth <= 0) return j
  }
  return ts.length - 1
}

function plainText(ts: Token[] | null | undefined): string {
  let s = ''
  for (const t of ts || []) {
    if (t.type === 'text' || t.type === 'code_inline' || t.type === 'math_inline') s += t.content
    else if (t.type === 'softbreak' || t.type === 'hardbreak') s += ' '
    else if (t.type === 'image') s += plainText(t.children) || t.content
  }
  return s
}

/** GitHub-style heading slug (github-slugger semantics). */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-')
}

const fenceLang = (info: string) => (info || '').trim().split(/\s+/)[0].toLowerCase()

const usable = (img: DocxImage | null | undefined): img is DocxImage =>
  !!img && img.data instanceof Uint8Array && img.data.length > 0 && img.mime in MIME_EXT

type InlineState = { b: number; i: number; s: number; u: number; sup: number; sub: number; mark: number; code: number }
const HTML_TAG_STATE: Record<string, keyof InlineState> = {
  b: 'b', strong: 'b', i: 'i', em: 'i', s: 's', del: 's', strike: 's', u: 'u', ins: 'u',
  sup: 'sup', sub: 'sub', mark: 'mark', code: 'code', kbd: 'code',
}

// ------------------------------------------------------------------ writer
class DocxWriter {
  private env: Record<string, unknown> = {}
  private images = new Map<string, DocxImage>()
  private diagrams = new Map<Token, DocxImage>()
  private media = new Map<DocxImage, string>() // image -> "media/imageN.ext"
  private docPart = newPart(10)                // rId1-4 are the fixed parts
  private fnPart = newPart(1)
  private fnDefs = new Map<string, Token[]>()
  private fnIds = new Map<string, number>()
  private fnOrder: string[] = []
  private headingBm = new Map<Token, string>()
  private slugs = new Map<string, string>()   // slug -> bookmark name
  private firstHeading = ''
  private orderedNums: { numId: number; ilvl: number; start: number }[] = []
  private bmId = 0
  private docPrId = 0
  private hasToc = false

  constructor(private opts: DocxOptions) {}

  async convert(markdown: string): Promise<Uint8Array> {
    const env = {}
    const all = md.parse(markdown, env)
    this.env = env
    await this.preload(all)
    const body = this.extractFootnotes(all)
    this.indexHeadings(body)
    const blocks: Block[] = []
    this.blocks(body, 0, body.length, this.rootCx(this.docPart, false), blocks)
    const bodyXml = this.serialize(blocks)
    const footnotes = this.fnOrder.length ? this.footnotesXml() : null
    return this.pack(bodyXml, footnotes)
  }

  // ---------------------------------------------------------------- prepass
  private async preload(tokens: Token[]) {
    const srcs = new Set<string>()
    const diagrams: Token[] = []
    const walk = (ts: Token[]) => {
      for (const t of ts) {
        if (t.type === 'image') { const src = t.attrGet('src'); if (src) srcs.add(src) }
        else if (t.type === 'fence' && fenceLang(t.info) === 'mermaid') diagrams.push(t)
        if (t.children) walk(t.children)
      }
    }
    walk(tokens)
    await Promise.all([...srcs].map(async src => {
      try { const img = await this.opts.loadImage(src); if (usable(img)) this.images.set(src, img) } catch { /* alt text instead */ }
    }))
    // one at a time: mermaid rendering is not re-entrant
    for (const t of diagrams) {
      try { const img = await this.opts.mermaidToPng(t.content); if (usable(img)) this.diagrams.set(t, img) } catch { /* code block instead */ }
    }
  }

  /** Footnote definitions sit in place in the stream; lift them out of the body. */
  private extractFootnotes(tokens: Token[]): Token[] {
    const body: Token[] = []
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.type === 'footnote_def_open') {
        const j = closeOf(tokens, i)
        const label = String(t.meta?.label ?? '')
        if (!this.fnDefs.has(label)) this.fnDefs.set(label, tokens.slice(i + 1, j))
        i = j
        continue
      }
      body.push(t)
    }
    return body
  }

  private indexHeadings(body: Token[]) {
    const seen = new Map<string, number>()
    for (let i = 0; i < body.length; i++) {
      const t = body[i]
      if (t.type !== 'heading_open') continue
      const text = plainText(body[i + 1]?.children).trim()
      if (!this.firstHeading && text) this.firstHeading = text
      const base = slugify(text)
      let slug = base
      while (seen.has(slug)) {
        const n = (seen.get(base) ?? 0) + 1
        seen.set(base, n)
        slug = `${base}-${n}`
      }
      seen.set(slug, 0)
      const name = `_md${this.headingBm.size + 1}` // leading "_" = hidden bookmark
      this.headingBm.set(t, name)
      if (!this.slugs.has(slug)) this.slugs.set(slug, name)
    }
  }

  private anchor(href: string): string | null {
    let frag = href.slice(1)
    try { frag = decodeURIComponent(frag) } catch { /* keep raw */ }
    return this.slugs.get(frag) ?? this.slugs.get(frag.toLowerCase()) ?? this.slugs.get(slugify(frag)) ?? null
  }

  // ---------------------------------------------------------------- blocks
  private rootCx(part: Part, footnote: boolean): Cx {
    return { part, footnote, container: 'root', indent: 0, listDepth: 0, tight: false }
  }

  private blocks(ts: Token[], from: number, to: number, cx: Cx, out: Block[]) {
    for (let i = from; i < to; i++) {
      const t = ts[i]
      switch (t.type) {
        case 'paragraph_open': {
          const j = closeOf(ts, i)
          this.paragraph(ts[i + 1], cx, out)
          i = j
          break
        }
        case 'heading_open': {
          const j = closeOf(ts, i)
          this.flush(cx, out)
          this.heading(t, ts[i + 1], cx, out)
          i = j
          break
        }
        case 'blockquote_open': {
          const j = closeOf(ts, i)
          this.flush(cx, out)
          this.blocks(ts, i + 1, j, {
            ...cx, container: 'quote', indent: cx.indent + QUOTE_INDENT,
            bar: { color: COLOR.rule, sz: 18, pos: cx.indent + 120 },
          }, out)
          i = j
          break
        }
        case 'callout_open': {
          const j = closeOf(ts, i)
          this.flush(cx, out)
          this.callout(t, ts, i, j, cx, out)
          i = j
          break
        }
        case 'bullet_list_open':
        case 'ordered_list_open': {
          const j = closeOf(ts, i)
          this.flush(cx, out)
          this.list(ts, i, j, cx, out)
          i = j
          break
        }
        case 'table_open': {
          const j = closeOf(ts, i)
          this.flush(cx, out)
          this.table(ts, i, j, cx, out)
          i = j
          break
        }
        case 'fence': {
          this.flush(cx, out)
          const lang = fenceLang(t.info)
          const img = lang === 'mermaid' ? this.diagrams.get(t) : undefined
          if (img) this.push(out, cx, { ...this.basePP(cx), jc: 'center' }, this.drawing(img, cx.part, 'mermaid diagram', this.maxImg(cx)))
          else if (lang === 'math' || lang === 'katex') this.mathBlock(t.content, cx, out)
          else this.code(t.content, cx, out)
          break
        }
        case 'code_block':
          this.flush(cx, out)
          this.code(t.content, cx, out)
          break
        case 'math_block':
          this.flush(cx, out)
          this.mathBlock(t.content, cx, out)
          break
        case 'hr':
          this.flush(cx, out)
          this.push(out, cx, { left: cx.indent || undefined, bottom: { color: COLOR.rule, sz: 6, space: 1 }, after: 240, markSz: 12 }, '')
          break
        case 'html_block':
          this.htmlBlock(t.content, cx, out)
          break
        case 'toc':
          this.flush(cx, out)
          if (!cx.footnote) this.toc(cx, out)
          break
        case 'footnote_def_open': // nested definition inside a footnote
          i = closeOf(ts, i)
          break
        default: // front_matter, ref_def, closing tokens, unknown containers (their content still renders)
          break
      }
    }
  }

  /** Paragraph defaults for the context (style, indent, list spacing). */
  private basePP(cx: Cx): PProps {
    const pp: PProps = {}
    if (cx.footnote) pp.style = 'FootnoteText'
    else if (cx.container === 'item') pp.style = 'ListParagraph'
    else if (cx.container === 'quote') pp.style = 'Quote'
    if (cx.indent) pp.left = cx.indent
    if (cx.container === 'item' && !cx.footnote) {
      pp.after = cx.tight ? 0 : 120
      pp.contextual = cx.tight
    }
    return pp
  }

  /** Quote / callout decoration: left rule (kept aligned across indents) and shading. */
  private push(out: Block[], cx: Cx, pp: PProps, body: string) {
    if (cx.bar) {
      const edge = (pp.left ?? 0) - (pp.hanging ?? 0)
      const space = Math.max(0, Math.min(31, Math.round((edge - cx.bar.pos) / 20)))
      pp.bar = { color: cx.bar.color, sz: cx.bar.sz, space }
    }
    if (cx.fill && !pp.shd) pp.shd = cx.fill
    out.push({ kind: 'p', pp, body })
  }

  /** A text paragraph; the first one in a list item carries the item's number. */
  private para(cx: Cx, out: Block[], body: string, extra: PProps = {}) {
    const pp: PProps = { ...this.basePP(cx), ...extra }
    let prefix = ''
    const it = cx.item
    if (it && !it.used) {
      it.used = true
      pp.left = it.left
      pp.hanging = LIST_HANG
      const box = it.task ? '☑' : '☐'
      if (it.bulletTask) {
        pp.tabs = [it.left]
        prefix = runs(box, { font: 'symbol' }) + '<w:r><w:tab/></w:r>'
      } else {
        pp.numId = it.numId
        pp.ilvl = it.ilvl
        if (it.task != null) prefix = runs(box + ' ', { font: 'symbol' })
      }
    }
    this.push(out, cx, pp, prefix + body)
  }

  /** A non-paragraph block is about to start a list item: give the number its own line. */
  private flush(cx: Cx, out: Block[]) {
    if (cx.item && !cx.item.used) this.para(cx, out, '')
  }

  private ix(cx: Cx, heading = false): Ix {
    return { part: cx.part, footnote: cx.footnote, base: {}, codeSz: heading ? undefined : cx.footnote ? 16 : 20, maxImg: this.maxImg(cx) }
  }

  private maxImg(cx: Cx): number {
    return Math.min(MAX_IMG_W, Math.max(TEXT_W / 4, TEXT_W - cx.indent) * TWIP_EMU)
  }

  private paragraph(inl: Token | undefined, cx: Cx, out: Block[]) {
    const kids = inl?.children || []
    // a paragraph that is nothing but $$…$$ is display math
    const sig = kids.filter(k => !(k.type === 'softbreak' || (k.type === 'text' && !k.content.trim())))
    if (sig.length === 1 && sig[0].type === 'math_inline' && sig[0].markup === '$$') {
      this.flush(cx, out)
      this.mathBlock(sig[0].content, cx, out)
      return
    }
    this.para(cx, out, this.inline(kids, this.ix(cx)))
  }

  private heading(open: Token, inl: Token | undefined, cx: Cx, out: Block[]) {
    const level = Math.min(6, Math.max(1, parseInt(open.tag.slice(1), 10) || 1))
    const ix = this.ix(cx, true)
    if (cx.footnote) ix.base = { b: true }
    let body = this.inline(inl?.children, ix)
    const pp: PProps = { style: cx.footnote ? 'FootnoteText' : `Heading${level}` }
    if (cx.indent) pp.left = cx.indent
    const bm = cx.footnote ? undefined : this.headingBm.get(open)
    if (bm) {
      const id = this.bmId++
      body = `<w:bookmarkStart w:id="${id}" w:name="${bm}"/>${body}<w:bookmarkEnd w:id="${id}"/>`
    }
    this.push(out, cx, pp, body)
  }

  private callout(open: Token, ts: Token[], i: number, j: number, cx: Cx, out: Block[]) {
    const meta = open.meta || {}
    const kind = String(meta.kind || 'note')
    const { color, fill } = calloutColors(kind)
    const ccx: Cx = {
      ...cx, container: 'callout', indent: cx.indent + QUOTE_INDENT,
      bar: { color, sz: 24, pos: cx.indent + 60 }, fill,
    }
    const base: RP = { b: true, color }
    const rawTitle = String(meta.title || '').trim()
    let title: string
    if (rawTitle) {
      const inl = md.parseInline(rawTitle, this.env)[0]
      title = this.inline(inl?.children, { ...this.ix(ccx), base })
    } else {
      title = runs(CALLOUT_LABEL[calloutKind(kind)] || kind, base)
    }
    this.push(out, ccx, { style: cx.footnote ? 'FootnoteText' : undefined, left: ccx.indent, keepNext: true, after: 80 }, title)
    this.blocks(ts, i + 1, j, ccx, out)
  }

  private list(ts: Token[], i: number, j: number, cx: Cx, out: Block[]) {
    const open = ts[i]
    const ordered = open.type === 'ordered_list_open'
    const ilvl = Math.min(cx.listDepth, 8)
    let numId = BULLET_NUM
    if (ordered) {
      const raw = open.attrGet('start') as string | number | null // markdown-it stores a number
      const start = raw == null ? 1 : parseInt(String(raw), 10)
      numId = BULLET_NUM + 1 + this.orderedNums.length
      this.orderedNums.push({ numId, ilvl, start: Number.isFinite(start) && start >= 0 ? start : 1 })
    }
    // markdown-it hides the paragraphs of tight lists
    let tight = true
    for (let k = i + 1; k < j; k++) {
      if (ts[k].type === 'paragraph_open' && ts[k].level === open.level + 2) { tight = ts[k].hidden; break }
    }
    const left = cx.indent + LIST_INDENT
    for (let k = i + 1; k < j; k++) {
      const t = ts[k]
      if (t.type !== 'list_item_open') continue
      const kc = closeOf(ts, k)
      const checked = t.meta?.checked
      const task = typeof checked === 'boolean' ? checked : undefined
      const item: ListItem = { numId, ilvl, left, task, bulletTask: !ordered && task !== undefined, used: false }
      const icx: Cx = { ...cx, container: 'item', indent: left, listDepth: cx.listDepth + 1, item, tight }
      this.blocks(ts, k + 1, kc, icx, out)
      if (!item.used) this.para(icx, out, '')
      k = kc
    }
    // the outermost list ends with normal paragraph spacing
    if (cx.container !== 'item') {
      const last = out[out.length - 1]
      if (last?.kind === 'p' && (last.pp.after ?? 160) < 160) {
        last.pp.after = 160
        last.pp.contextual = false
      }
    }
  }

  private code(text: string, cx: Cx, out: Block[]) {
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
    const sz = cx.footnote ? 16 : 19
    lines.forEach((line, n) => {
      this.push(out, cx, {
        style: 'CodeBlock', shd: COLOR.codeBg,
        left: cx.indent + CODE_PAD, right: CODE_PAD,
        before: 0, after: n === lines.length - 1 ? 160 : 0, line: 240,
      }, runs(line, { font: 'code', sz }))
    })
  }

  private mathBlock(tex: string, cx: Cx, out: Block[]) {
    const src = tex.trim()
    if (!src) return
    const omml = this.omml(src, true)
    if (omml) this.push(out, cx, this.basePP(cx), `<m:oMathPara>${omml}</m:oMathPara>`)
    else this.code(src, cx, out)
  }

  private toc(cx: Cx, out: Block[]) {
    this.hasToc = true
    const body = '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
      + `<w:r><w:instrText xml:space="preserve">${esc(' TOC \\o "1-3" \\h \\z \\u ')}</w:instrText></w:r>`
      + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
      + runs('右键更新目录', { color: COLOR.muted })
      + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
    this.push(out, cx, { left: cx.indent || undefined }, body)
  }

  private htmlBlock(html: string, cx: Cx, out: Block[]) {
    if (/<svg[\s>/]/i.test(html)) return
    let s = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    if (!s.trim()) return
    s = s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote|pre|table|ul|ol|details|summary)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
    const text = decodeEntities(s).split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n')
    if (!text) return
    this.para(cx, out, runs(text))
  }

  private table(ts: Token[], i: number, j: number, cx: Cx, out: Block[]) {
    type Cell = { inl: Token | null; align?: 'left' | 'center' | 'right' }
    const rows: { head: boolean; cells: Cell[] }[] = []
    let head = false
    let row: Cell[] | null = null
    for (let k = i + 1; k < j; k++) {
      const t = ts[k]
      switch (t.type) {
        case 'thead_open': head = true; break
        case 'thead_close': head = false; break
        case 'tr_open': row = []; break
        case 'tr_close': if (row) rows.push({ head, cells: row }); row = null; break
        case 'th_open':
        case 'td_open': {
          const m = /text-align\s*:\s*(left|center|right)/i.exec(t.attrGet('style') || '')
          row?.push({
            inl: ts[k + 1]?.type === 'inline' ? ts[k + 1] : null,
            align: m ? (m[1].toLowerCase() as Cell['align']) : undefined,
          })
          break
        }
      }
    }
    if (!rows.length) return
    const cols = Math.max(1, ...rows.map(r => r.cells.length))
    const width = TEXT_W - cx.indent
    const colW = Math.floor(width / cols)
    const maxImg = Math.max(TWIP_EMU, Math.min(MAX_IMG_W, (colW - 230) * TWIP_EMU))
    let x = '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>'
      + (cx.indent ? `<w:tblW w:w="${width}" w:type="dxa"/><w:tblInd w:w="${cx.indent}" w:type="dxa"/>` : '<w:tblW w:w="5000" w:type="pct"/>')
      + '</w:tblPr><w:tblGrid>' + `<w:gridCol w:w="${colW}"/>`.repeat(cols) + '</w:tblGrid>'
    for (const r of rows) {
      x += '<w:tr>' + (r.head ? '<w:trPr><w:tblHeader/></w:trPr>' : '')
      for (let c = 0; c < cols; c++) {
        const cell = r.cells[c]
        const ix: Ix = { part: cx.part, footnote: cx.footnote, base: r.head ? { b: true } : {}, codeSz: cx.footnote ? 16 : 20, maxImg }
        const body = cell?.inl ? this.inline(cell.inl.children, ix) : ''
        const pp: PProps = { style: cx.footnote ? 'FootnoteText' : undefined, before: 40, after: 40, line: 240, jc: cell?.align }
        x += `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>`
          + (r.head ? `<w:shd w:val="clear" w:color="auto" w:fill="${COLOR.headBg}"/>` : '')
          + `</w:tcPr><w:p>${pPr(pp)}${body}</w:p></w:tc>`
      }
      x += '</w:tr>'
    }
    out.push({ kind: 'tbl', xml: x + '</w:tbl>' })
  }

  // ---------------------------------------------------------------- inline
  private inline(kids: Token[] | null | undefined, ix: Ix): string {
    if (!kids?.length) return ''
    let out = ''
    let link: { open: string | null; buf: string } | null = null
    const st: InlineState = { b: 0, i: 0, s: 0, u: 0, sup: 0, sub: 0, mark: 0, code: 0 }
    const props = (): RP => {
      const p: RP = { ...ix.base }
      if (st.b) p.b = true
      if (st.i) p.i = true
      if (st.s) p.strike = true
      if (st.u) p.u = true
      if (st.mark) p.hl = true
      if (st.sup) p.va = 'superscript'
      else if (st.sub) p.va = 'subscript'
      if (link?.open) { p.style = 'Hyperlink'; p.color = COLOR.link; p.u = true }
      if (st.code) { p.font = 'code'; p.shd = COLOR.inlineBg; if (ix.codeSz) p.sz = ix.codeSz }
      return p
    }
    const emit = (x: string) => { if (link) link.buf += x; else out += x }
    const endLink = () => {
      if (!link) return
      out += link.open ? `${link.open}${link.buf}</w:hyperlink>` : link.buf
      link = null
    }
    const bump = (k: keyof InlineState, d: number) => { st[k] = Math.max(0, st[k] + d) }

    for (const t of kids) {
      switch (t.type) {
        case 'text': emit(runs(t.content, props())); break
        case 'softbreak': emit(runs(' ', props())); break
        case 'hardbreak': emit(BR); break
        case 'code_inline': {
          const p = props()
          emit(runs(t.content, { ...p, font: 'code', shd: COLOR.inlineBg, sz: ix.codeSz ?? p.sz }))
          break
        }
        case 'strong_open': bump('b', 1); break
        case 'strong_close': bump('b', -1); break
        case 'em_open': bump('i', 1); break
        case 'em_close': bump('i', -1); break
        case 's_open': bump('s', 1); break
        case 's_close': bump('s', -1); break
        case 'link_open': endLink(); link = { open: this.linkOpen(t, ix.part), buf: '' }; break
        case 'link_close': endLink(); break
        case 'image': emit(this.image(t, ix, props())); break
        case 'math_inline': emit(this.omml(t.content, false) ?? runs(t.content, { ...props(), font: 'code' })); break
        case 'footnote_ref': emit(this.footnoteRef(String(t.meta?.label ?? ''), ix, props())); break
        case 'html_inline': {
          const m = /^<\s*(\/?)\s*([A-Za-z][\w-]*)\b[^>]*?(\/?)\s*>$/.exec(t.content.trim())
          if (!m) break
          const tag = m[2].toLowerCase()
          if (tag === 'br') emit(BR)
          else if (HTML_TAG_STATE[tag] && !m[3]) bump(HTML_TAG_STATE[tag], m[1] ? -1 : 1)
          break
        }
        default:
          if (t.nesting === 0 && t.content) emit(runs(t.content, props()))
      }
    }
    endLink()
    return out
  }

  private linkOpen(t: Token, part: Part): string | null {
    const href = (t.attrGet('href') || '').trim()
    if (!href) return null
    const title = t.attrGet('title')
    const tip = title ? ` w:tooltip="${esc(title)}"` : ''
    if (href.startsWith('#')) {
      const bm = this.anchor(href)
      return bm ? `<w:hyperlink w:anchor="${bm}"${tip} w:history="1">` : null
    }
    return `<w:hyperlink r:id="${this.rel(part, 'hyperlink', href, true)}"${tip} w:history="1">`
  }

  private footnoteRef(label: string, ix: Ix, p: RP): string {
    if (!this.fnDefs.has(label)) return runs(`[^${label}]`, p)
    const known = this.fnIds.get(label)
    if (ix.footnote || known != null) {
      // Word can't reference one footnote twice, nor from inside a footnote: show its number
      return runs(String(known ?? label), { ...p, style: 'FootnoteReference', va: 'superscript' })
    }
    const id = this.fnOrder.push(label)
    this.fnIds.set(label, id)
    return `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`
  }

  private image(t: Token, ix: Ix, p: RP): string {
    const src = t.attrGet('src') || ''
    const alt = plainText(t.children) || t.content || ''
    const img = this.images.get(src)
    if (img) return this.drawing(img, ix.part, alt, ix.maxImg)
    return runs(alt || src, { ...p, i: true })
  }

  private drawing(img: DocxImage, part: Part, alt: string, maxW: number): string {
    let file = this.media.get(img)
    if (!file) {
      file = `media/image${this.media.size + 1}.${MIME_EXT[img.mime]}`
      this.media.set(img, file)
    }
    const rid = this.rel(part, 'image', file, false)
    let cx = Math.round((img.width > 0 ? img.width : 96) * PX_EMU)
    let cy = Math.round((img.height > 0 ? img.height : 96) * PX_EMU)
    const scale = Math.min(1, maxW / cx, MAX_IMG_H / cy)
    cx = Math.max(1, Math.round(cx * scale))
    cy = Math.max(1, Math.round(cy * scale))
    const id = ++this.docPrId
    return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
      + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
      + `<wp:docPr id="${id}" name="Picture ${id}" descr="${esc(alt)}"/>`
      + '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
      + `<a:graphic><a:graphicData uri="${NS.pic}"><pic:pic>`
      + `<pic:nvPicPr><pic:cNvPr id="${id}" name="${file.slice(6)}"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
      + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
  }

  private omml(tex: string, display: boolean): string | null {
    if (!tex.trim()) return null
    let mathml: string | null
    try { mathml = this.opts.mathToMathML(tex, display) } catch { return null }
    return mathml ? mathmlToOmml(mathml) : null
  }

  private rel(part: Part, type: string, target: string, external: boolean): string {
    const key = `${type} ${target}`
    let id = part.ids.get(key)
    if (!id) {
      id = `rId${part.base + part.rels.length}`
      part.rels.push({ id, type, target, external })
      part.ids.set(key, id)
    }
    return id
  }

  // ---------------------------------------------------------------- parts
  private serialize(blocks: Block[]): string {
    let s = ''
    let prev: Block | undefined
    for (const b of blocks) {
      if (b.kind === 'tbl') {
        if (prev?.kind === 'tbl') s += '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>' // keep tables apart
        s += b.xml
      } else {
        if (prev?.kind === 'tbl' && b.pp.before == null) b.pp.before = 160
        s += `<w:p>${pPr(b.pp)}${b.body}</w:p>`
      }
      prev = b
    }
    if (!prev || prev.kind === 'tbl') s += '<w:p/>' // containers must end with a paragraph
    return s
  }

  private footnotesXml(): string {
    const sep = (kind: string, id: number, el: string) =>
      `<w:footnote w:type="${kind}" w:id="${id}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:${el}/></w:r></w:p></w:footnote>`
    let x = `${XML_DECL}<w:footnotes ${PART_NS}>` + sep('separator', -1, 'separator') + sep('continuationSeparator', 0, 'continuationSeparator')
    const ref = '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>'
    this.fnOrder.forEach((label, n) => {
      const def = this.fnDefs.get(label) || []
      const blocks: Block[] = []
      this.blocks(def, 0, def.length, this.rootCx(this.fnPart, true), blocks)
      const first = blocks[0]
      if (first?.kind === 'p' && first.pp.style === 'FootnoteText' && first.pp.numId == null && !first.pp.tabs && !first.body.startsWith('<m:oMathPara')) {
        first.body = ref + first.body
      } else {
        blocks.unshift({ kind: 'p', pp: { style: 'FootnoteText' }, body: ref })
      }
      x += `<w:footnote w:id="${n + 1}">${this.serialize(blocks)}</w:footnote>`
    })
    return x + '</w:footnotes>'
  }

  private pack(body: string, footnotes: string | null): Uint8Array {
    const title = (this.opts.title ?? '').trim() || this.firstHeading
    const files: Zippable = {}
    const add = (path: string, xml: string) => { files[path] = strToU8(xml) }

    add('[Content_Types].xml', contentTypesXml(!!footnotes))
    add('_rels/.rels', relsXml([
      { id: 'rId1', type: REL_TYPE + 'officeDocument', target: 'word/document.xml', external: false },
      { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml', external: false },
      { id: 'rId3', type: REL_TYPE + 'extended-properties', target: 'docProps/app.xml', external: false },
    ]))
    add('docProps/core.xml', coreXml(title))
    add('docProps/app.xml', `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>YuMarkEditor</Application><DocSecurity>0</DocSecurity></Properties>`)

    const sectPr = `<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>`
    add('word/document.xml', `${XML_DECL}<w:document ${PART_NS}><w:body>${body}${sectPr}</w:body></w:document>`)
    const fixed: Rel[] = [
      { id: 'rId1', type: REL_TYPE + 'styles', target: 'styles.xml', external: false },
      { id: 'rId2', type: REL_TYPE + 'numbering', target: 'numbering.xml', external: false },
      { id: 'rId3', type: REL_TYPE + 'settings', target: 'settings.xml', external: false },
    ]
    if (footnotes) fixed.push({ id: 'rId4', type: REL_TYPE + 'footnotes', target: 'footnotes.xml', external: false })
    add('word/_rels/document.xml.rels', relsXml([...fixed, ...this.docPart.rels.map(r => ({ ...r, type: REL_TYPE + r.type }))]))
    add('word/styles.xml', stylesXml())
    add('word/numbering.xml', this.numberingXml())
    add('word/settings.xml', settingsXml(this.hasToc, !!footnotes))
    if (footnotes) {
      add('word/footnotes.xml', footnotes)
      if (this.fnPart.rels.length) add('word/_rels/footnotes.xml.rels', relsXml(this.fnPart.rels.map(r => ({ ...r, type: REL_TYPE + r.type }))))
    }
    for (const [img, file] of this.media) files['word/' + file] = [img.data, { level: 0 }]
    return zipSync(files, { level: 6 })
  }

  private numberingXml(): string {
    const lvls = (bullet: boolean) => Array.from({ length: 9 }, (_, L) =>
      `<w:lvl w:ilvl="${L}"><w:start w:val="1"/>`
      + `<w:numFmt w:val="${bullet ? 'bullet' : ORDERED_FMT[L % 3]}"/>`
      + `<w:lvlText w:val="${bullet ? BULLETS[L % 3] : `%${L + 1}.`}"/><w:lvlJc w:val="left"/>`
      + `<w:pPr><w:ind w:left="${LIST_INDENT * (L + 1)}" w:hanging="${LIST_HANG}"/></w:pPr></w:lvl>`).join('')
    let x = `${XML_DECL}<w:numbering xmlns:w="${NS.w}">`
      + `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${lvls(true)}</w:abstractNum>`
      + `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvls(false)}</w:abstractNum>`
      + `<w:num w:numId="${BULLET_NUM}"><w:abstractNumId w:val="0"/></w:num>`
    for (const n of this.orderedNums) {
      x += `<w:num w:numId="${n.numId}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="${n.ilvl}"><w:startOverride w:val="${n.start}"/></w:lvlOverride></w:num>`
    }
    return x + '</w:numbering>'
  }
}

// ------------------------------------------------------------------ static parts
function relsXml(rels: Rel[]): string {
  return `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + rels.map(r => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')
    + '</Relationships>'
}

function contentTypesXml(footnotes: boolean): string {
  const o = (part: string, type: string) => `<Override PartName="${part}" ContentType="${type}"/>`
  const wml = 'application/vnd.openxmlformats-officedocument.wordprocessingml.'
  return `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/>'
    + '<Default Extension="jpeg" ContentType="image/jpeg"/>'
    + '<Default Extension="gif" ContentType="image/gif"/>'
    + o('/word/document.xml', wml + 'document.main+xml')
    + o('/word/styles.xml', wml + 'styles+xml')
    + o('/word/numbering.xml', wml + 'numbering+xml')
    + o('/word/settings.xml', wml + 'settings+xml')
    + (footnotes ? o('/word/footnotes.xml', wml + 'footnotes+xml') : '')
    + o('/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml')
    + o('/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml')
    + '</Types>'
}

function coreXml(title: string): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  return `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${esc(title)}</dc:title>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`
    + '</cp:coreProperties>'
}

function settingsXml(toc: boolean, footnotes: boolean): string {
  return `${XML_DECL}<w:settings xmlns:w="${NS.w}" xmlns:m="${NS.m}">`
    + '<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>'
    + (toc ? '<w:updateFields w:val="true"/>' : '')
    + (footnotes ? '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>' : '')
    + '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>'
    + '<m:mathPr><m:mathFont m:val="Cambria Math"/><m:brkBin m:val="before"/><m:brkBinSub m:val="--"/><m:smallFrac m:val="0"/><m:dispDef/><m:lMargin m:val="0"/><m:rMargin m:val="0"/><m:defJc m:val="centerGroup"/><m:wrapIndent m:val="1440"/><m:intLim m:val="subSup"/><m:naryLim m:val="undOvr"/></m:mathPr>'
    + '<w:themeFontLang w:val="en-US" w:eastAsia="zh-CN"/>'
    + '<w:decimalSymbol w:val="."/><w:listSeparator w:val=","/>'
    + '</w:settings>'
}

function stylesXml(): string {
  const codeFonts = `<w:rFonts w:ascii="${FONT.code}" w:hAnsi="${FONT.code}" w:eastAsia="${FONT.code}" w:cs="${FONT.code}"/>`
  const heading = (n: number, sz: number, before: number, after: number, rule: boolean, color = COLOR.text) =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>`
    + '<w:pPr><w:keepNext/><w:keepLines/>'
    + (rule ? `<w:pBdr>${border('bottom', { color: COLOR.rule, sz: 6, space: 4 })}</w:pBdr>` : '')
    + `<w:spacing w:before="${before}" w:after="${after}" w:line="264" w:lineRule="auto"/><w:outlineLvl w:val="${n - 1}"/></w:pPr>`
    + `<w:rPr><w:b/><w:bCs/><w:color w:val="${color}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>`
  return `${XML_DECL}<w:styles xmlns:w="${NS.w}">`
    + '<w:docDefaults>'
    + `<w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT.latin}" w:eastAsia="${FONT.eastAsia}" w:hAnsi="${FONT.latin}" w:cs="${FONT.latin}"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>`
    + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
    + '</w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>'
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>'
    + heading(1, 40, 360, 160, true)
    + heading(2, 32, 320, 140, true)
    + heading(3, 28, 280, 120, false)
    + heading(4, 24, 240, 100, false)
    + heading(5, 22, 240, 80, false)
    + heading(6, 22, 240, 80, false, COLOR.muted)
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/>'
    + `<w:pPr><w:pBdr>${border('left', { color: COLOR.rule, sz: 18, space: 12 })}</w:pBdr><w:ind w:left="${QUOTE_INDENT}" w:right="0"/></w:pPr>`
    + `<w:rPr><w:color w:val="${COLOR.muted}"/></w:rPr></w:style>`
    + '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:qFormat/>'
    + `<w:pPr><w:pBdr>${border('left', { color: COLOR.codeBg, sz: 4, space: 4 })}${border('right', { color: COLOR.codeBg, sz: 4, space: 4 })}</w:pBdr>`
    + `<w:shd w:val="clear" w:color="auto" w:fill="${COLOR.codeBg}"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="${CODE_PAD}" w:right="${CODE_PAD}"/><w:contextualSpacing/></w:pPr>`
    + `<w:rPr>${codeFonts}<w:noProof/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>`
    + '<w:style w:type="character" w:styleId="InlineCode"><w:name w:val="Inline Code"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/>'
    + `<w:rPr>${codeFonts}<w:noProof/><w:shd w:val="clear" w:color="auto" w:fill="${COLOR.inlineBg}"/></w:rPr></w:style>`
    + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>'
    + `<w:rPr><w:color w:val="${COLOR.link}"/><w:u w:val="single"/></w:rPr></w:style>`
    + '<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>'
    + '<w:pPr><w:spacing w:after="40" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>'
    + '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'
    + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/>'
    + '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => border(s, { color: COLOR.grid, sz: 4, space: 0 })).join('')
    + '</w:tblBorders><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/>'
    + `<w:pPr><w:ind w:left="${LIST_INDENT}"/><w:contextualSpacing/></w:pPr></w:style>`
    + '</w:styles>'
}

// ------------------------------------------------------------------ MathML -> OMML
// mathml2omml emits a few things Word rejects (checked against v0.5.0):
// `<w:rPr>` before `<m:rPr>` in m:r, `m:sty="undefined"` next to `m:nor`,
// `m:argPr/m:scrLvl` (not in the schema, sometimes repeated), and `m:pos` as
// an attribute of `m:chr`. Its output is parsed into a tiny tree, repaired and
// re-serialised; anything that does not parse falls back to the TeX source.

interface XEl { n: string; at: [string, string][]; k: (XEl | string)[] }

const TAG_RE = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y
const ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
const BAD_AMP = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/

function parseXml(src: string): XEl | null {
  const root: XEl = { n: '#root', at: [], k: [] }
  const stack: XEl[] = [root]
  let pos = 0
  while (pos < src.length) {
    const lt = src.indexOf('<', pos)
    const end = lt < 0 ? src.length : lt
    if (end > pos) {
      const text = src.slice(pos, end)
      if (BAD_AMP.test(text)) return null
      stack[stack.length - 1].k.push(text)
      pos = end
      continue
    }
    if (src.startsWith('<?', pos) || src.startsWith('<!--', pos)) {
      const close = src.indexOf(src[pos + 1] === '?' ? '?>' : '-->', pos)
      if (close < 0) return null
      pos = close + (src[pos + 1] === '?' ? 2 : 3)
      continue
    }
    TAG_RE.lastIndex = pos
    const m = TAG_RE.exec(src)
    if (!m) return null
    pos = TAG_RE.lastIndex
    if (m[1]) {
      const top = stack.pop()
      if (!top || top.n !== m[2] || !stack.length) return null
      continue
    }
    const at: [string, string][] = []
    for (const a of m[3].matchAll(ATTR_RE)) {
      const v = a[3] ?? a[4] ?? ''
      if (BAD_AMP.test(v)) return null
      at.push([a[1], v.replace(/"/g, '&quot;')])
    }
    const el: XEl = { n: m[2], at, k: [] }
    stack[stack.length - 1].k.push(el)
    if (!m[4]) stack.push(el)
  }
  return stack.length === 1 ? root : null
}

const isEl = (x: XEl | string, name?: string): x is XEl => typeof x !== 'string' && (!name || x.n === name)
const TEXT_ELEMENTS = new Set(['m:t', 'w:t'])
const MATH_STY = new Set(['p', 'b', 'i', 'bi'])
const MRPR_ORDER = ['m:lit', 'm:nor', 'm:scr', 'm:sty', 'm:brk', 'm:aln']

/** `<m:r><m:t>…<m:limUpp/>…</m:t></m:r>` (e.g. \stackrel, \bmod): lift the math out of the text. */
function hoistRun(r: XEl): (XEl | string)[] | null {
  const t = r.k.find(x => isEl(x, 'm:t'))
  if (!t || !t.k.some(x => isEl(x))) return null
  const props = r.k.filter(x => isEl(x) && x.n !== 'm:t')
  return t.k.map(x => (isEl(x) ? x : { n: 'm:r', at: [], k: [...props, { n: 'm:t', at: [['xml:space', 'preserve']], k: [x] }] }))
}

function fixOmml(el: XEl) {
  el.at = el.at.filter(([k]) => !k.startsWith('xmlns'))
  for (let changed = true; changed;) {
    changed = false
    el.k = el.k.flatMap(c => {
      const lifted = isEl(c, 'm:r') ? hoistRun(c) : null
      if (lifted) changed = true
      return lifted ?? [c]
    })
  }
  const kids: (XEl | string)[] = []
  for (const c of el.k) {
    if (!isEl(c)) {
      if (TEXT_ELEMENTS.has(el.n)) kids.push(clean(c))
      continue // stray text outside m:t is not allowed
    }
    if (c.n === 'm:argPr') continue
    fixOmml(c)
    kids.push(c)
    const pos = c.n === 'm:chr' ? c.at.find(([k]) => k === 'm:pos') : undefined
    if (pos) {
      c.at = c.at.filter(a => a !== pos)
      if (!el.k.some(x => isEl(x, 'm:pos'))) kids.push({ n: 'm:pos', at: [['m:val', pos[1]]], k: [] })
    }
  }
  el.k = kids
  if (el.n === 'm:r') {
    // CT_R: m:rPr?, w:rPr?, content
    const mrPr = el.k.find(x => isEl(x, 'm:rPr'))
    const wrPr = el.k.find(x => isEl(x, 'w:rPr') && x.k.length > 0)
    const rest = el.k.filter(x => !isEl(x, 'm:rPr') && !isEl(x, 'w:rPr'))
    el.k = [...(mrPr ? [mrPr] : []), ...(wrPr ? [wrPr] : []), ...rest]
  } else if (el.n === 'm:rPr') {
    let k = el.k.filter((x): x is XEl => isEl(x)).filter(x => x.n !== 'm:sty' || MATH_STY.has(x.at.find(([a]) => a === 'm:val')?.[1] ?? ''))
    // m:nor and m:scr/m:sty are alternatives: a real style wins, otherwise keep "normal text"
    if (k.some(x => x.n === 'm:sty')) k = k.filter(x => x.n !== 'm:nor')
    else if (k.some(x => x.n === 'm:nor')) k = k.filter(x => x.n !== 'm:scr')
    const rank = (x: XEl) => { const r = MRPR_ORDER.indexOf(x.n); return r < 0 ? 99 : r }
    el.k = k.filter((x, n) => k.findIndex(y => y.n === x.n) === n).sort((a, b) => rank(a) - rank(b))
  }
}

function writeXml(el: XEl): string {
  const at = el.at.map(([k, v]) => ` ${k}="${v}"`).join('')
  if (!el.k.length) return `<${el.n}${at}/>`
  return `<${el.n}${at}>${el.k.map(c => (typeof c === 'string' ? c : writeXml(c))).join('')}</${el.n}>`
}

function mathmlToOmml(mathml: string): string | null {
  const m = /<math\b[\s\S]*<\/math>/i.exec(mathml)
  if (!m) return null
  const src = m[0].replace(/<annotation(?:-xml)?\b[\s\S]*?<\/annotation(?:-xml)?\s*>/gi, '')
  let raw: string
  const warn = console.warn
  console.warn = () => {} // the converter logs every unsupported element
  try {
    raw = mml2omml(src, { disableDecode: true }) // keep entities encoded so the output stays well-formed
  } catch {
    return null
  } finally {
    console.warn = warn
  }
  const root = parseXml(raw)
  if (!root) return null
  let math = root.k.find((x): x is XEl => isEl(x, 'm:oMath'))
  if (!math) {
    const para = root.k.find((x): x is XEl => isEl(x, 'm:oMathPara'))
    math = para?.k.find((x): x is XEl => isEl(x, 'm:oMath'))
  }
  if (!math) return null
  fixOmml(math)
  return writeXml(math)
}
