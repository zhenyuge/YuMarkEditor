import { Schema, type NodeSpec, type MarkSpec } from 'prosemirror-model'
import { tableNodes } from 'prosemirror-tables'

const tables = tableNodes({
  tableGroup: 'block',
  cellContent: 'inline*',
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: (dom: HTMLElement) => dom.style.textAlign || dom.getAttribute('align') || null,
      setDOMAttr: (value: unknown, attrs: Record<string, unknown>) => {
        if (value) attrs.style = `text-align:${value}`
      },
    },
  },
})

const codeLike = (name: string, extra: Partial<NodeSpec> = {}): NodeSpec => ({
  content: 'text*',
  marks: '',
  group: 'block',
  code: true,
  defining: true,
  ...extra,
  toDOM: () => ['pre', { class: name }, ['code', 0]],
})

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },

  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },

  heading: {
    attrs: { level: { default: 1 }, setext: { default: false } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map(level => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: node => [`h${node.attrs.level}`, 0],
  },

  blockquote: {
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: () => ['blockquote', 0],
  },

  callout: {
    attrs: { kind: { default: 'NOTE' }, fold: { default: '' }, title: { default: '' } },
    content: 'block*',
    group: 'block',
    defining: true,
    parseDOM: [{
      tag: 'div.callout',
      getAttrs: (dom: HTMLElement) => ({
        kind: dom.getAttribute('data-kind') || 'NOTE',
        fold: dom.getAttribute('data-fold') || '',
        title: dom.getAttribute('data-title') || '',
      }),
      contentElement: '.callout-body',
    }],
    toDOM: node => ['div', {
      class: 'callout', 'data-kind': node.attrs.kind, 'data-fold': node.attrs.fold, 'data-title': node.attrs.title,
    }, ['div', { class: 'callout-body' }, 0]],
  },

  code_block: codeLike('code-block', {
    attrs: { info: { default: '' }, fence: { default: '```' }, indented: { default: false } },
    parseDOM: [{
      tag: 'pre',
      preserveWhitespace: 'full',
      getAttrs: (dom: HTMLElement) => {
        const code = dom.querySelector('code')
        const cls = (code?.className || dom.className || '').match(/(?:^|\s)language-([\w+#.-]+)/)
        return { info: dom.getAttribute('data-info') || (cls ? cls[1] : '') }
      },
    }],
  }),

  math_block: codeLike('math-block', {
    attrs: { markup: { default: '$$' } },
    parseDOM: [{ tag: 'pre.math-block', preserveWhitespace: 'full', priority: 60 }],
  }),

  html_block: codeLike('html-block', {
    parseDOM: [{ tag: 'pre.html-block', preserveWhitespace: 'full', priority: 60 }],
  }),

  frontmatter: codeLike('frontmatter', {
    attrs: { fence: { default: '---' } },
    parseDOM: [{ tag: 'pre.frontmatter', preserveWhitespace: 'full', priority: 60 }],
  }),

  ref_def: codeLike('ref-def', {
    parseDOM: [{ tag: 'pre.ref-def', preserveWhitespace: 'full', priority: 60 }],
  }),

  horizontal_rule: {
    attrs: { markup: { default: '---' } },
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: () => ['hr'],
  },

  toc: {
    attrs: { markup: { default: '[TOC]' } },
    group: 'block',
    atom: true,
    selectable: true,
    parseDOM: [{ tag: 'div.toc' }],
    toDOM: () => ['div', { class: 'toc' }],
  },

  bullet_list: {
    attrs: { tight: { default: true }, bullet: { default: '-' } },
    content: 'list_item+',
    group: 'block',
    parseDOM: [{ tag: 'ul', getAttrs: (dom: HTMLElement) => ({ tight: dom.hasAttribute('data-tight') || !dom.querySelector('li > p + *') }) }],
    toDOM: node => ['ul', { 'data-tight': node.attrs.tight ? 'true' : null }, 0],
  },

  ordered_list: {
    attrs: { order: { default: 1 }, tight: { default: true }, delim: { default: '.' }, same: { default: false } },
    content: 'list_item+',
    group: 'block',
    parseDOM: [{
      tag: 'ol',
      getAttrs: (dom: HTMLElement) => ({
        order: dom.hasAttribute('start') ? +dom.getAttribute('start')! : 1,
        tight: dom.hasAttribute('data-tight') || !dom.querySelector('li > p + *'),
      }),
    }],
    toDOM: node => ['ol', {
      start: node.attrs.order === 1 ? null : node.attrs.order,
      'data-tight': node.attrs.tight ? 'true' : null,
    }, 0],
  },

  list_item: {
    attrs: { checked: { default: null } },
    content: 'block+',
    defining: true,
    parseDOM: [{
      tag: 'li',
      getAttrs: (dom: HTMLElement) => {
        const box = dom.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]') as HTMLInputElement | null
        const attr = dom.getAttribute('data-checked')
        return { checked: attr != null ? attr === 'true' : box ? box.checked : null }
      },
    }],
    toDOM: node => ['li', { 'data-checked': node.attrs.checked == null ? null : String(node.attrs.checked) }, 0],
  },

  footnote_def: {
    attrs: { label: { default: '1' } },
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'div.footnote-def', getAttrs: (dom: HTMLElement) => ({ label: dom.getAttribute('data-label') || '1' }) }],
    toDOM: node => ['div', { class: 'footnote-def', 'data-label': node.attrs.label }, 0],
  },

  ...tables,

  text: { group: 'inline' },

  hard_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },

  image: {
    inline: true,
    group: 'inline',
    draggable: true,
    attrs: { src: { default: '' }, alt: { default: '' }, title: { default: null } },
    parseDOM: [{
      tag: 'img[src]',
      getAttrs: (dom: HTMLElement) => ({
        src: dom.getAttribute('data-src') || dom.getAttribute('src') || '',
        alt: dom.getAttribute('alt') || '',
        title: dom.getAttribute('title'),
      }),
    }],
    toDOM: node => ['img', { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title }],
  },

  math_inline: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { tex: { default: '' }, markup: { default: '$' } },
    parseDOM: [{ tag: 'span.math-inline', getAttrs: (dom: HTMLElement) => ({ tex: dom.getAttribute('data-tex') || dom.textContent || '' }) }],
    toDOM: node => ['span', { class: 'math-inline', 'data-tex': node.attrs.tex }, node.attrs.tex],
  },

  html_inline: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { html: { default: '' } },
    parseDOM: [{ tag: 'span.html-inline', getAttrs: (dom: HTMLElement) => ({ html: dom.getAttribute('data-html') || dom.textContent || '' }) }],
    toDOM: node => ['span', { class: 'html-inline', 'data-html': node.attrs.html }, node.attrs.html],
  },

  footnote_ref: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { label: { default: '1' } },
    parseDOM: [{ tag: 'sup.footnote-ref', getAttrs: (dom: HTMLElement) => ({ label: dom.getAttribute('data-label') || dom.textContent || '1' }) }],
    toDOM: node => ['sup', { class: 'footnote-ref', 'data-label': node.attrs.label }, `[^${node.attrs.label}]`],
  },
}

const marks: Record<string, MarkSpec> = {
  em: {
    attrs: { markup: { default: '*' } },
    parseDOM: [
      { tag: 'i' }, { tag: 'em' },
      { style: 'font-style=italic' },
      { style: 'font-style=normal', clearMark: m => m.type.name === 'em' },
    ],
    toDOM: () => ['em', 0],
  },

  strong: {
    attrs: { markup: { default: '**' } },
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b', getAttrs: (node: HTMLElement) => node.style.fontWeight !== 'normal' && null },
      { style: 'font-weight=400', clearMark: m => m.type.name === 'strong' },
      { style: 'font-weight', getAttrs: (value: string) => /^(bold(er)?|[5-9]\d{2,})$/.test(value) && null },
    ],
    toDOM: () => ['strong', 0],
  },

  strike: {
    attrs: { markup: { default: '~~' } },
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }, { style: 'text-decoration=line-through' }],
    toDOM: () => ['s', 0],
  },

  link: {
    attrs: { href: { default: '' }, title: { default: null }, markup: { default: null } },
    inclusive: false,
    parseDOM: [{
      tag: 'a[href]',
      getAttrs: (dom: HTMLElement) => ({ href: dom.getAttribute('href'), title: dom.getAttribute('title') }),
    }],
    toDOM: node => ['a', { href: node.attrs.href, title: node.attrs.title }, 0],
  },

  code: {
    parseDOM: [{ tag: 'code' }],
    toDOM: () => ['code', 0],
  },
}

export const schema = new Schema({ nodes, marks })

// Code-bearing blocks whose text is shown as a rendered preview when the caret
// is elsewhere.
export const PREVIEW_BLOCKS = new Set(['math_block', 'html_block', 'frontmatter'])

export function codeLang(info: string): string {
  return (info || '').trim().split(/[\s{]/)[0].toLowerCase()
}
