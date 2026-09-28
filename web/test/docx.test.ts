// Builds a DOCX from a feature-rich sample and checks the package contents.
// cd web && npx esbuild test/docx.test.ts --bundle --platform=node --format=cjs --outfile=test/.out/docxtest.cjs && node test/.out/docxtest.cjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import katex from 'katex'
import { markdownToDocx, type DocxImage } from '../src/export/docx'

// 1x1 transparent PNG
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
const png = (width: number, height: number): DocxImage => ({ data: PNG, mime: 'image/png', width, height })

const sample = `---
title: 前置元数据不应出现
---

# YuMarkEditor 导出测试

[TOC]

这是一段**粗体**、*斜体*、~~删除线~~和 \`inline code\` 的中文段落，含[外部链接](https://example.com/a?b=1&c=2 "示例")与[跳到表格](#表格-table)。
软换行后继续，
行尾反斜杠硬换行\\
以及 HTML<br>换行和 <sup>上标</sup> 文本。控制字符\u0001已剔除\u000b。

## 列表 Lists

- 第一项
- 第二项
  - 嵌套 A
  - 嵌套 B
    1. 深层有序
    2. 深层有序二
- [ ] 待办任务
- [x] 已完成任务

3. 从三开始
4. 第四项

   第四项的续段落

中间段落把两个有序列表分开。

1. 新列表重新编号
2. 第二个

## 表格 Table

| 左对齐 | 居中 | 右对齐 |
|:---|:---:|---:|
| **粗** | \`code\` | 3.14 |
| 中文单元格 | [链接](https://example.org) | $x^2$ |

## 代码 Code

\`\`\`js
function hello(name) {
\tconsole.log("hi <" + name + "> & bye")
    return 42
}
\`\`\`

> 这是一段引用，含有 *强调*。
>
> > 嵌套引用

> [!WARNING] 警告标题
> 警告内容，含脚注[^note]。

> [!tip]
> Obsidian 风格提示

## 数学 Math

行内公式 $E = mc^2$ 与 $a < b$，坏公式 $\\frac{1$ 回退。

$$
\\int_0^\\infty e^{-x}\\,dx = 1
$$

\`\`\`math
\\frac{a}{b}
\`\`\`

脚注引用[^1]和再次引用[^1]。

[^1]: 这是脚注内容，**加粗**。
[^note]: 第二个脚注。
[^unused]: 从未引用的脚注。

## 图表 Diagram

\`\`\`mermaid
graph TD; A-->B
\`\`\`

![示例图片](image.png "标题") ![坏图片](missing.png) ![宽图](wide.png)

---

<div>HTML 块 <b>文本</b></div>

<!-- 只是注释 -->

<svg width="10" height="10"><circle r="4"/></svg>

### 表格 Table

[回到顶部](#yumarkeditor-导出测试)
`

let fails = 0
const check = (ok: unknown, what: string) => {
  if (!ok) { fails++; console.log('FAIL', what) }
}

async function main() {
  const t0 = Date.now()
  const bytes = await markdownToDocx(sample, {
    title: 'YuMarkEditor 样例',
    async loadImage(src) {
      if (src === 'image.png') return png(1, 1)
      if (src === 'wide.png') return png(2000, 1000)
      return null
    },
    mathToMathML(tex, displayMode) {
      const s = katex.renderToString(tex, { output: 'mathml', displayMode, throwOnError: false })
      return /<math[\s\S]*<\/math>/.exec(s)?.[0] ?? null
    },
    async mermaidToPng() { return png(1, 1) },
  })
  const outDir = join(__dirname)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'sample.docx'), bytes)
  console.log(`wrote ${join(outDir, 'sample.docx')} (${bytes.length} bytes, ${Date.now() - t0} ms)`)

  const zip = unzipSync(bytes)
  const text = (p: string) => (zip[p] ? strFromU8(zip[p]) : '')
  for (const p of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml',
    'word/numbering.xml', 'word/settings.xml', 'word/footnotes.xml', 'docProps/core.xml', 'docProps/app.xml']) check(zip[p], `part ${p}`)
  check(Object.keys(zip)[0] === '[Content_Types].xml', 'content types is the first zip entry')

  const doc = text('word/document.xml')
  const fn = text('word/footnotes.xml')
  const rels = text('word/_rels/document.xml.rels')
  const num = text('word/numbering.xml')
  const styles = text('word/styles.xml')
  const settings = text('word/settings.xml')

  check(doc.includes('w:w="11906" w:h="16838"'), 'A4 page')
  check(/<w:pStyle w:val="Heading1"\/>/.test(doc) && /<w:pStyle w:val="Heading3"\/>/.test(doc), 'heading styles')
  check(styles.includes('<w:outlineLvl w:val="0"/>') && styles.includes('<w:outlineLvl w:val="5"/>'), 'outline levels')
  check(styles.includes('w:eastAsia="等线"') && styles.includes('w:ascii="Menlo"'), 'fonts')
  check(!doc.includes('前置元数据'), 'front matter skipped')
  check(doc.includes('TOC \\o &quot;1-3&quot; \\h \\z \\u') && doc.includes('右键更新目录'), 'TOC field')
  check(settings.includes('<w:updateFields w:val="true"/>'), 'updateFields')
  check(/<w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">粗体/.test(doc), 'bold run')
  check(doc.includes('<w:strike/>'), 'strike run')
  check(doc.includes('<w:vertAlign w:val="superscript"/></w:rPr><w:t xml:space="preserve">上标'), '<sup> html inline')
  check(!/[\u0001\u000b]/.test(doc) && doc.includes('控制字符已剔除'), 'invalid XML chars stripped')
  check(/<w:hyperlink r:id="rId\d+"/.test(doc) && /TargetMode="External"/.test(rels) && rels.includes('https://example.com/a?b=1&amp;c=2'), 'external hyperlink')
  const anchor = /<w:hyperlink w:anchor="(_md\d+)"/.exec(doc)
  check(anchor && doc.includes(`<w:bookmarkStart w:id="`) && doc.includes(`w:name="${anchor[1]}"`), '#anchor hyperlink + bookmark')
  // "#表格-table" must hit the first "表格 Table" heading (H2 #4), not the later duplicate
  const bms = [...doc.matchAll(/w:name="(_md\d+)"\/><w:r><w:t xml:space="preserve">([^<]*)/g)].map(m => [m[1], m[2]])
  const tableBm = bms.find(b => b[1] === '表格 Table')?.[0]
  check(tableBm && doc.includes(`w:anchor="${tableBm}"`), 'anchor resolves to first matching heading')
  check(doc.includes('硬换行</w:t></w:r><w:r><w:br/></w:r>') && doc.includes('HTML</w:t></w:r><w:r><w:br/></w:r>'), 'hard breaks (markdown + <br>)')
  check(doc.includes('软换行后继续，</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>'), 'softbreak -> space')
  check(num.includes('<w:startOverride w:val="3"/>') && (num.match(/<w:startOverride w:val="1"\/>/g) || []).length >= 2, 'ordered restarts + start')
  check(num.includes('w:val="•"') && num.includes('w:val="lowerLetter"'), 'bullet/decimal abstractNums')
  check(/<w:numPr><w:ilvl w:val="2"\/>/.test(doc), 'nested ilvl 2')
  check(doc.includes('☐') && doc.includes('☑'), 'task checkboxes')
  check(/<w:pStyle w:val="ListParagraph"\/><w:spacing[^>]*\/><w:ind w:left="720"\/>[^]*?第四项的续段落/.test(doc), 'continuation paragraph indented, no number')
  check(doc.includes('<w:tblHeader/>') && doc.includes('<w:jc w:val="center"/>') && doc.includes('<w:jc w:val="right"/>'), 'table header + alignment')
  check(doc.includes('<w:tblW w:w="5000" w:type="pct"/>'), 'table full width')
  check(doc.includes('<w:pStyle w:val="CodeBlock"/>') && doc.includes('<w:tab/>') && doc.includes('>    return 42<'), 'code block lines/tabs/spaces')
  check(doc.includes('hi &lt;&quot; + name + &quot;&gt; &amp; bye'), 'code escaping')
  check(doc.includes('<w:pStyle w:val="Quote"/>'), 'quote style')
  check(doc.includes('w:color="BF6A02"') && doc.includes('警告标题') && doc.includes('w:fill="FFF5E5"'), 'warning callout')
  check(doc.includes('提示') && doc.includes('w:color="1A7F37"'), 'tip callout default title')
  check((doc.match(/<m:oMath>/g) || []).length >= 4, 'inline math oMath')
  check((doc.match(/<m:oMathPara>/g) || []).length === 2, 'display math oMathPara')
  check(doc.includes('xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'), 'm namespace on document')
  check(!/m:argPr|m:scrLvl|m:val="undefined"|<w:rPr\/><m:rPr>/.test(doc), 'OMML sanitized')
  check(/<w:rFonts w:ascii="Menlo"[^>]*\/>(?:<w:noProof\/>)?<\/w:rPr><w:t xml:space="preserve">\\frac\{1/.test(doc), 'bad TeX falls back to code font')
  check(doc.includes('<w:footnoteReference w:id="1"/>') && doc.includes('<w:footnoteReference w:id="2"/>') && !doc.includes('w:footnoteReference w:id="3"'), 'footnote refs')
  check(/<w:rStyle w:val="FootnoteReference"\/><w:vertAlign w:val="superscript"\/><\/w:rPr><w:t xml:space="preserve">2</.test(doc), 'repeated ref shows number')
  check(!doc.includes('这是脚注内容') && !doc.includes('第二个脚注') && !doc.includes('从未引用'), 'footnote bodies not in body')
  check(/w:id="1">.*第二个脚注/.test(fn.replace(/<w:footnote w:id="2">.*/, '')) && fn.includes('这是脚注内容') && !fn.includes('从未引用'), 'footnote ordering by first reference')
  check(fn.includes('w:type="separator" w:id="-1"') && fn.includes('w:type="continuationSeparator" w:id="0"') && fn.includes('<w:footnoteRef/>'), 'footnote separators/ref')
  check(settings.includes('<w:footnote w:id="-1"/>'), 'footnotePr in settings')
  const drawings = doc.match(/<w:drawing>/g) || []
  check(drawings.length === 3, `3 drawings (got ${drawings.length})`)
  const ids = [...doc.matchAll(/<wp:docPr id="(\d+)"/g)].map(m => m[1])
  check(new Set(ids).size === ids.length, 'unique docPr ids')
  check([...doc.matchAll(/<wp:extent cx="(\d+)"/g)].every(m => +m[1] <= 6.3 * 914400), 'images fit 6.3in')
  check(/<w:i\/><w:iCs\/><\/w:rPr><w:t xml:space="preserve">坏图片/.test(doc), 'missing image -> italic alt')
  check(Object.keys(zip).some(k => k.startsWith('word/media/image')), 'media part')
  check(/Relationship Id="rId\d+" Type="[^"]+\/image" Target="media\/image1\.png"/.test(rels), 'image relationship')
  check(doc.includes('<w:bottom w:val="single"'), 'hr bottom border')
  check(doc.includes('HTML 块 文本') && !doc.includes('只是注释') && !doc.includes('circle'), 'html blocks')
  check(text('docProps/core.xml').includes('<dc:title>YuMarkEditor 样例</dc:title>'), 'core title')

  console.log(fails ? `${fails} check(s) failed` : 'all docx checks passed')
  if (fails) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exitCode = 1 })
