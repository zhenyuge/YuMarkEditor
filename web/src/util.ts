export const dirname = (p: string) => {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)

export const stripExt = (name: string) => name.replace(/\.(md|markdown|mdown|mkd|mdx|txt)$/i, '')

export function normalizePath(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}

export function joinPath(dir: string, rel: string) {
  return normalizePath(dir + '/' + rel)
}

/** Relative path from directory `from` to file `to` (both absolute). */
export function relativePath(from: string, to: string): string {
  const a = normalizePath(from).split('/').filter(Boolean)
  const b = normalizePath(to).split('/').filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const up = a.slice(i).map(() => '..')
  return [...up, ...b.slice(i)].join('/') || '.'
}

/** URL the web view can load for a local absolute path (same origin as the app). */
export function localURL(path: string): string {
  return '/@fs' + path.split('/').map(encodeURIComponent).join('/')
}

function safeDecode(s: string) {
  try { return decodeURIComponent(s) } catch { return s }
}

/** Resolve an image/link target from a document to something loadable. */
export function resolveSrc(src: string, docDir: string | null): string {
  if (!src) return ''
  if (/^(https?|data|blob):/i.test(src)) return src
  if (/^file:\/\//i.test(src)) return localURL(safeDecode(src.replace(/^file:\/\//i, '')))
  if (src.startsWith('/')) return localURL(safeDecode(src))
  if (src.startsWith('~/') && homeDir) return localURL(homeDir + safeDecode(src.slice(1)))
  if (!docDir) return ''
  return localURL(joinPath(docDir, safeDecode(src.split(/[?#]/)[0])))
}

export let homeDir = ''
export function setHomeDir(h: string) { homeDir = h }

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T & { flush(): void; cancel(): void } {
  let t: any = null
  let lastArgs: any[] = []
  const f: any = (...args: any[]) => {
    lastArgs = args
    clearTimeout(t)
    t = setTimeout(() => { t = null; fn(...lastArgs) }, ms)
  }
  f.flush = () => { if (t) { clearTimeout(t); t = null; fn(...lastArgs) } }
  f.cancel = () => { clearTimeout(t); t = null }
  return f
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, any> = {}, ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k === 'html') el.innerHTML = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children) if (c != null && c !== false) el.append(c)
  return el
}

export function escapeHTML(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

export function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH) as any)
  return btoa(s)
}

export const isMac = true
