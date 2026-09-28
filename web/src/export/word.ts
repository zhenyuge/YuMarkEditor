// Word export glue: supplies images, formulas and diagrams to the DOCX writer.
import { markdownToDocx, type DocxImage } from './docx'
import { loadKatex, renderMermaid } from '../render'
import { resolveSrc } from '../util'

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

async function toPNG(img: HTMLImageElement | ImageBitmap, w: number, h: number, scale = 1): Promise<DocxImage> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img as any, 0, 0, canvas.width, canvas.height)
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'))
  return { data: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', width: w, height: h }
}

async function svgToPNG(svg: string): Promise<DocxImage | null> {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement
  const vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number)
  let w = parseFloat(root.getAttribute('width') || '') || vb[2] || 600
  let h = parseFloat(root.getAttribute('height') || '') || vb[3] || 400
  if (/%/.test(root.getAttribute('width') || '') && vb[2]) { w = vb[2]; h = vb[3] }
  root.setAttribute('width', String(w))
  root.setAttribute('height', String(h))
  root.removeAttribute('style')
  const xml = new XMLSerializer().serializeToString(root)
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml)
  try {
    const img = await loadImg(url)
    return await toPNG(img, w, h, 2)
  } catch {
    return null
  }
}

export async function exportDocx(markdown: string, opts: { title: string; docDir: string | null }): Promise<Uint8Array> {
  const katex = /\$|```\s*(math|katex)/.test(markdown) ? await loadKatex() : null
  return markdownToDocx(markdown, {
    title: opts.title,
    async loadImage(src: string) {
      let decoded = src
      try { decoded = decodeURI(src) } catch {}
      const url = resolveSrc(decoded, opts.docDir)
      if (!url) return null
      try {
        const res = await fetch(url)
        if (!res.ok) return null
        const blob = await res.blob()
        const type = blob.type || ''
        if (type === 'image/svg+xml' || /\.svg$/i.test(decoded)) return svgToPNG(await blob.text())
        const bmp = await createImageBitmap(blob)
        const { width, height } = bmp
        if (type === 'image/png' || type === 'image/jpeg' || type === 'image/gif') {
          bmp.close()
          return { data: new Uint8Array(await blob.arrayBuffer()), mime: type as DocxImage['mime'], width, height }
        }
        const out = await toPNG(bmp, width, height)
        bmp.close()
        return out
      } catch {
        return null
      }
    },
    mathToMathML(tex: string, display: boolean) {
      if (!katex) return null
      try {
        const html = katex.renderToString(tex, { output: 'mathml', displayMode: display, throwOnError: false, strict: 'ignore' })
        const m = /<math[\s\S]*<\/math>/.exec(html)
        return m ? m[0] : null
      } catch {
        return null
      }
    },
    async mermaidToPng(code: string) {
      try {
        const svg = await renderMermaid(code, { theme: 'default', htmlLabels: false })
        return await svgToPNG(svg)
      } catch {
        return null
      }
    },
  })
}
