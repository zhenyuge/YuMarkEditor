import { parseMarkdown } from '../src/md/parse'
import { composeMarkdown, emptySourceInfo } from '../src/md/compose'
import { md } from '../src/md/markdown'
import { schema } from '../src/md/schema'
// @ts-ignore
import spec from 'commonmark-spec'

let fails = 0
const log = (...a: any[]) => console.log(...a)

// 1. exact round-trip without edits
function exact(name: string, text: string) {
  const { doc, info } = parseMarkdown(text)
  const out = composeMarkdown(doc, info).text
  if (out !== text) { fails++; log('EXACT FAIL', name, JSON.stringify(text), '=>', JSON.stringify(out)) }
}

// 2. forced serialization must render to the same HTML
function norm(html: string) { return html.replace(/\s+/g, ' ').replace(/> </g, '><').trim() }
const semanticFails: string[] = []
function semantic(name: string, text: string) {
  const { doc, info } = parseMarkdown(text)
  const forced = { ...emptySourceInfo(info.eol), env: info.env }
  const out = composeMarkdown(doc, forced).text
  const a = norm(md.render(text)), b = norm(md.render(out))
  if (a !== b) semanticFails.push(`--- ${name}\nIN:  ${JSON.stringify(text)}\nOUT: ${JSON.stringify(out)}\nA: ${a}\nB: ${b}`)
}

const examples = (spec as any).tests.map((t: any) => ({ name: `#${t.number} ${t.section}`, text: t.markdown.replace(/→/g, '\t') }))
for (const ex of examples) {
  exact(ex.name, ex.text)
  exact(ex.name + ' crlf', ex.text.replace(/\n/g, '\r\n'))
  exact(ex.name + ' nofinal', ex.text.replace(/\n$/, ''))
  semantic(ex.name, ex.text)
}

const custom = `---
title: 测试
tags: [a, b]
---

# 标题 Setext 不在这里

Setext H1
=========

* star list
* item two
    * nested

- [ ] task
- [x] done

| 左 | 中   |  右 |
|:---|:----:|---:|
| a  | b    |  c  |

my_var and [[双向链接]] and ![[嵌入]] and #标签

> [!NOTE] 提示标题
> 内容 **粗体**

> [!warning]- 折叠

$$
E = mc^2
$$

行内 $a+b$ 公式和脚注[^1]。

[^1]: 脚注内容
    第二行

[TOC]

\`\`\`mermaid
graph TD; A-->B
\`\`\`

[ref]: https://example.com "Title"

A [ref] link.

<svg width="10" height="10"><circle r="4"/></svg>

Last line no newline`
exact('custom', custom)
exact('custom crlf', custom.replace(/\n/g, '\r\n'))
semantic('custom', custom)
{ const r = parseMarkdown('\ufeff# hi\n'); if (!r.info.bom || composeMarkdown(r.doc, r.info).text !== '# hi\n') { fails++; log('BOM FAIL') } }

// 3. edits: change one block, the rest must stay byte-identical
{
  const text = custom.replace(/\n/g, '\r\n')
  const { doc, info } = parseMarkdown(text)
  // find paragraph containing "my_var"
  let pos = -1, node: any = null
  doc.forEach((n, off) => { if (pos < 0 && n.textContent.startsWith('my_var')) { pos = off; node = n } })
  const edited = doc.replace(pos + 1, pos + 1, new (require('prosemirror-model').Slice)(require('prosemirror-model').Fragment.from(schema.text('X ')), 0, 0))
  const out = composeMarkdown(edited, info).text
  const expected = text.replace('my_var and', 'X my_var and')
  if (out !== expected) { fails++; log('EDIT FAIL\n' + JSON.stringify(out) + '\n' + JSON.stringify(expected)) }
  else log('edit preserve OK')
}

log(`exact failures: ${fails}`)
log(`semantic failures: ${semanticFails.length} / ${examples.length + 1}`)
if (process.env.SHOW) log(semanticFails.slice(0, +process.env.SHOW).join('\n'))
