import { TextSelection } from 'prosemirror-state'
import { bridge, isNative } from './bridge'
import { Doc } from './app/doc'
import { TabBar } from './app/tabbar'
import { Sidebar } from './app/sidebar'
import { FindBar, type Searchable } from './app/findbar'
import { RichEditor } from './rich/editor'
import { editorCtx } from './rich/context'
import { nodeViews } from './rich/nodeviews'
import { parseMarkdown } from './md/parse'
import { composeMarkdown } from './md/compose'
import type { SourceEditor } from './source/editor'
import { basename, debounce, dirname, h, joinPath, localURL, normalizePath, relativePath, setHomeDir, stripExt, toBase64 } from './util'

// ------------------------------------------------------------------ state
const docs: Doc[] = []
let active: Doc | null = null
let closedStack: { path: string; mode: string }[] = []
let appSupport = '/tmp'
const prefs = { autosave: false, fontSize: 16, lastDir: '' as string, sidebarWidth: 240, showSidebar: false, folder: null as string | null }
let quitting = false

// ------------------------------------------------------------------ DOM
const app = h('div', { id: 'app' })
document.body.append(app)
const main = h('div', { class: 'main' })
const editorArea = h('div', { class: 'editor-area' })
const banner = h('div', { class: 'banner' })
const richScroller = h('div', { class: 'scroller rich-scroller' })
const richHost = h('div', { class: 'rich-host' })
richScroller.append(richHost)
const srcScroller = h('div', { class: 'scroller source-scroller hidden' })
const srcHost = h('div', { class: 'source-host' })
srcScroller.append(srcHost)
const status = h('div', { class: 'status' })
const toastEl = h('div', { class: 'toast' })
editorArea.append(banner, richScroller, srcScroller, status, toastEl)
main.append(editorArea)

const tabbar = new TabBar(app, {
  docs: () => docs,
  active: () => active,
  activate: d => activate(d),
  close: d => { closeDoc(d) },
  newDoc: () => newDoc(),
  contextMenu: (d, x, y) => tabMenu(d, x, y),
  reorder: (from, to) => { const [d] = docs.splice(from, 1); docs.splice(to, 0, d); tabbar.render(); persistSoon() },
  toggleSidebar: () => toggleSidebar(),
  sidebarVisible: () => document.body.classList.contains('show-sidebar'),
})
app.append(main)

const sidebar = new Sidebar(main, {
  openFile: p => openPath(p),
  activePath: () => active?.path || null,
  renamed: (from, to) => {
    for (const d of docs) {
      if (d.path === from) d.path = to
      else if (d.path?.startsWith(from + '/')) d.path = to + d.path.slice(from.length)
    }
    tabbar.render(); updateWindow(); persistSoon()
  },
  trashed: p => {
    for (const d of docs) if (d.path === p || d.path?.startsWith(p + '/')) { d.missing = true }
    tabbar.render(); updateBanner()
  },
  closeFolder: () => { setFolder(null) },
  changed: () => {},
})
const resizer = h('div', { class: 'sb-resizer' })
main.append(resizer)

const rich = new RichEditor(richHost, richScroller)
rich.getEnv = () => active?.info.env || {}
let source: SourceEditor | null = null
let sourceLoading: Promise<SourceEditor> | null = null

function ensureSource(): Promise<SourceEditor> {
  return (sourceLoading ??= import('./source/editor').then(m => {
    source = new m.SourceEditor(srcHost)
    source.onChange = () => onEdit()
    return source
  }))
}

const searchTarget = (): Searchable => (active?.mode === 'source' && source ? source : rich) as Searchable
const findbar = new FindBar(editorArea, searchTarget)

// ------------------------------------------------------------------ helpers
function toast(msg: string, ms = 1800) {
  toastEl.textContent = msg
  toastEl.classList.add('show')
  clearTimeout((toast as any).t)
  ;(toast as any).t = setTimeout(() => toastEl.classList.remove('show'), ms)
}

function makePM(doc: any) {
  return rich.createState(doc)
}

function nextUntitledNo() {
  const used = new Set(docs.filter(d => !d.path).map(d => d.untitledNo))
  let n = 1
  while (used.has(n)) n++
  return n
}

function createDoc(text = '', path: string | null = null): Doc {
  const d = new Doc()
  d.path = path
  if (!path) d.untitledNo = nextUntitledNo()
  d.load(text, makePM)
  return d
}

/** keep the editor's live state in the doc object */
function stash(d: Doc | null) {
  if (!d || d !== active) return
  if (d.mode === 'rich') {
    d.pm = rich.state
    d.scroll.rich = richScroller.scrollTop
  } else if (source) {
    d.cm = source.state
    d.scroll.source = srcScroller.scrollTop
  }
}

function setDocDir(d: Doc) {
  editorCtx.docDir = d.path ? dirname(d.path) : null
  editorCtx.docPath = d.path
}

async function show(d: Doc) {
  setDocDir(d)
  if (d.mode === 'rich') {
    srcScroller.classList.add('hidden')
    richScroller.classList.remove('hidden')
    rich.setState(d.pm!)
    richScroller.scrollTop = d.scroll.rich
  } else {
    const s = await ensureSource()
    if (active !== d) return
    if (!d.cm) d.cm = s.createState(d.text().replace(/\r\n?/g, '\n'))
    richScroller.classList.add('hidden')
    srcScroller.classList.remove('hidden')
    s.setState(d.cm)
    srcScroller.scrollTop = d.scroll.source
  }
  updateBanner()
  updateStatus()
  findbar.reapply()
}

function focusEditor() {
  if (!active) return
  if (active.mode === 'rich') rich.focus()
  else source?.focus()
}

async function activate(d: Doc, focus = true) {
  if (active === d) { if (focus) focusEditor(); return }
  stash(active)
  rich.ui.hideAll()
  active = d
  await show(d)
  tabbar.render()
  sidebar.render()
  updateWindow()
  persistSoon()
  if (focus) focusEditor()
}

function updateWindow() {
  if (!active) return
  bridge.setWindow({ title: active.fileName, path: active.path, dirty: active.dirty })
  bridge.setMenuState({ mode: active.mode, autosave: prefs.autosave, sidebar: document.body.classList.contains('show-sidebar'), hasPath: !!active.path })
}

// ------------------------------------------------------------------ editing

const checkDirty = debounce((d: Doc) => {
  const was = d.dirty
  d.computeDirty()
  if (was !== d.dirty) { tabbar.render(); updateWindow() }
}, 250)

const autosave = debounce(() => {
  for (const d of docs) if (d.path && d.dirty && !d.conflict && !d.missing) save(d)
}, 1200)

function onEdit() {
  const d = active
  if (!d) return
  if (d.mode === 'rich') d.pm = rich.state
  else if (source) d.cm = source.state
  d.invalidate()
  if (!d.dirty) {
    d.dirty = true
    tabbar.render()
    updateWindow()
  }
  checkDirty(d)
  updateStatusSoon()
  persistSoon()
  if (prefs.autosave && d.path) autosave()
}
rich.onChange = () => onEdit()

function countWords(text: string) {
  const cjk = (text.match(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g) || []).length
  const words = (text.replace(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g, ' ').match(/[A-Za-z0-9À-ɏ'’-]+/g) || []).length
  return cjk + words
}

function updateStatus() {
  if (!active) return
  const text = active.mode === 'rich' ? rich.state.doc.textBetween(0, rich.state.doc.content.size, '\n', ' ') : source?.text() || ''
  const n = countWords(text)
  status.textContent = `${n.toLocaleString()} 字${active.mode === 'source' ? ' · 源码' : ''}`
}
const updateStatusSoon = debounce(updateStatus, 400)

// ------------------------------------------------------------------ open / new / close

function newDoc() {
  const d = createDoc()
  const i = active ? docs.indexOf(active) + 1 : docs.length
  docs.splice(i, 0, d)
  activate(d)
}

async function readDoc(path: string): Promise<Doc | null> {
  try {
    const f = await bridge.readFile(path)
    const d = createDoc(f.text, path)
    d.bom = f.bom
    d.diskText = f.text
    d.mtime = f.mtime
    return d
  } catch (e: any) {
    bridge.alert({ message: `无法打开「${basename(path)}」`, info: String(e?.message || e), buttons: ['好'], style: 'warning' })
    return null
  }
}

async function openPath(path: string, focus = true) {
  path = normalizePath(path)
  const existing = docs.find(d => d.path === path)
  if (existing) { await activate(existing, focus); return existing }
  const d = await readDoc(path)
  if (!d) return null
  if (active && active.isPristine()) {
    const i = docs.indexOf(active)
    docs[i] = d
    active = null
  } else {
    const i = active ? docs.indexOf(active) + 1 : docs.length
    docs.splice(i, 0, d)
  }
  await activate(d, focus)
  prefs.lastDir = dirname(path)
  return d
}

async function closeDoc(d: Doc): Promise<boolean> {
  if (d === active) stash(d)
  d.computeDirty()
  if (d.dirty) {
    if (d !== active) await activate(d)
    const r = await bridge.confirmClose(d.fileName)
    if (r === 'cancel') return false
    if (r === 'save' && !(await save(d))) return false
  }
  if (d.path) {
    closedStack = closedStack.filter(c => c.path !== d.path)
    closedStack.push({ path: d.path, mode: d.mode })
    if (closedStack.length > 30) closedStack.shift()
  }
  const i = docs.indexOf(d)
  docs.splice(i, 1)
  if (!docs.length) docs.push(createDoc())
  if (active === d) {
    active = null
    await activate(docs[Math.min(i, docs.length - 1)])
  } else {
    tabbar.render()
  }
  persistSoon()
  return true
}

async function closeMany(list: Doc[]) {
  for (const d of list) if (!(await closeDoc(d))) break
}

async function reopenClosed() {
  while (closedStack.length) {
    const c = closedStack.pop()!
    if (docs.some(d => d.path === c.path)) continue
    const d = await openPath(c.path)
    if (d && c.mode === 'source' && d.mode !== 'source') await toggleMode()
    return
  }
}

async function tabMenu(d: Doc, x: number, y: number) {
  const i = docs.indexOf(d)
  const id = await bridge.menu([
    { id: 'close', title: '关闭标签页' },
    { id: 'others', title: '关闭其他标签页', enabled: docs.length > 1 },
    { id: 'right', title: '关闭右侧标签页', enabled: i < docs.length - 1 },
    { id: 'left', title: '关闭左侧标签页', enabled: i > 0 },
    { id: 'saved', title: '关闭已保存的标签页' },
    { id: 'all', title: '关闭全部标签页' },
    { separator: true },
    { id: 'reopen', title: '重新打开关闭的标签页', enabled: closedStack.length > 0 },
    { separator: true },
    { id: 'reveal', title: '在访达中显示', enabled: !!d.path },
    { id: 'copyPath', title: '拷贝路径', enabled: !!d.path },
  ], x, y)
  switch (id) {
    case 'close': return closeDoc(d)
    case 'others': return closeMany(docs.filter(o => o !== d))
    case 'right': return closeMany(docs.slice(i + 1))
    case 'left': return closeMany(docs.slice(0, i))
    case 'saved': { stash(active); return closeMany(docs.filter(o => { o.computeDirty(); return !o.dirty })) }
    case 'all': return closeMany(docs.slice())
    case 'reopen': return reopenClosed()
    case 'reveal': return d.path && bridge.reveal(d.path)
    case 'copyPath': return d.path && navigator.clipboard?.writeText(d.path)
  }
}

// ------------------------------------------------------------------ saving

function suggestName(d: Doc): string {
  if (d.path) return basename(d.path)
  const text = d.text()
  const m = /^\s*#{1,6}\s+(.+)$/m.exec(text) || /^\s*(\S.*)$/m.exec(text.replace(/^---[\s\S]*?\n---\s*\n/, ''))
  let name = m ? m[1].replace(/[*_`~#[\]()<>$\\]/g, '').replace(/[/:\\?%*|"<>]/g, ' ').trim().slice(0, 40).trim() : ''
  if (!name) name = d.title
  return name + '.md'
}

async function relocateTempAssets(d: Doc, path: string, text: string): Promise<string> {
  const dir = dirname(path)
  for (const abs of d.tempAssets) {
    if (!text.includes(abs)) continue
    try {
      const final = await bridge.moveFile(abs, joinPath(dir, 'assets/' + basename(abs)))
      text = text.split(abs).join(relativePath(dir, final))
    } catch {}
  }
  return text
}

async function save(d: Doc, saveAs = false): Promise<boolean> {
  stash(active)
  let path = d.path
  if (!path || saveAs) {
    path = await bridge.saveDialog({ name: suggestName(d), dir: d.path ? dirname(d.path) : prefs.lastDir || prefs.folder || undefined, ext: 'md' })
    if (!path) return false
  }
  let text = d.text()
  const hadTemp = d.tempAssets.length > 0
  if (hadTemp) text = await relocateTempAssets(d, path, text)
  let mtime: number
  try {
    mtime = (await bridge.writeFile(path, text, d.bom)).mtime
  } catch (e: any) {
    bridge.alert({ message: `无法保存「${basename(path)}」`, info: String(e?.message || e), buttons: ['好'], style: 'warning' })
    return false
  }
  const moved = d.path !== path
  d.path = path
  if (hadTemp) {
    // image paths changed: reload the document from the saved text
    d.tempAssets = []
    const caret = d === active && d.mode === 'rich' ? rich.state.selection.from : null
    d.load(text, makePM)
    d.mode = 'rich'
    if (caret != null && d.pm) {
      try { d.pm = d.pm.apply(d.pm.tr.setSelection(TextSelection.near(d.pm.doc.resolve(Math.min(caret, d.pm.doc.content.size))))) } catch {}
    }
  }
  d.markSaved(text, mtime)
  prefs.lastDir = dirname(path)
  if (d === active) {
    setDocDir(d)
    if (moved || hadTemp) {
      rich.view.setProps({ nodeViews: { ...nodeViews } as any })
      await show(d)
    }
  }
  tabbar.render()
  updateWindow()
  updateBanner()
  if (sidebar.root && path.startsWith(sidebar.root + '/')) sidebar.refresh()
  persistSoon()
  return true
}

// ------------------------------------------------------------------ mode switch

/** plain text offset -> position inside a PM node */
function posInBlock(node: any, start: number, textOffset: number): number {
  let remaining = textOffset
  let result = start + 1
  let done = false
  node.descendants((n: any, pos: number) => {
    if (done) return false
    if (n.isText) {
      if (remaining <= n.text.length) { result = start + 1 + pos + remaining; done = true; return false }
      remaining -= n.text.length
      result = start + 1 + pos + n.nodeSize
    }
    return true
  })
  return result
}

async function toggleMode() {
  const d = active
  if (!d) return
  if (d.mode === 'rich') {
    d.pm = rich.state
    const text = d.text()
    const res = composeMarkdown(d.pm.doc, d.info)
    const caret = rich.caretBlock()
    const blockStart = res.offsets[caret.index] ?? 0
    // refine: look for the text before the caret inside the block's markdown
    let offset = blockStart
    const top = d.pm.doc.maybeChild(caret.index)
    if (top && top.isTextblock && caret.offset > 0) {
      const before = top.textBetween(0, Math.min(caret.offset, top.content.size), '\n', ' ')
      const probe = before.slice(-12)
      const end = res.offsets[caret.index + 1] ?? text.length
      const slice = text.slice(blockStart, end)
      const at = probe ? slice.indexOf(probe) : -1
      if (at >= 0) offset = blockStart + at + probe.length
    }
    const norm = text.replace(/\r\n?/g, '\n')
    const normOffset = text.slice(0, offset).replace(/\r\n?/g, '\n').length
    d.richBase = text
    d.sourceBase = { orig: text, norm }
    const s = await ensureSource()
    if (!d.cm || d.cm.doc.toString() !== norm) d.cm = s.createState(norm, normOffset)
    else d.cm = d.cm.update({ selection: { anchor: Math.min(normOffset, norm.length) }, scrollIntoView: true }).state
    d.scroll.rich = richScroller.scrollTop
    d.mode = 'source'
    d.invalidate()
    await show(d)
    requestAnimationFrame(() => s.scrollToCursor())
  } else {
    if (!source) return
    d.cm = source.state
    const text = d.text()
    const head = source.state.selection.main.head
    const line = source.state.doc.lineAt(head).number - 1
    const col = head - source.state.doc.lineAt(head).from
    if (text !== d.richBase) {
      const { doc, info } = parseMarkdown(text)
      d.info = info
      d.pm = rich.createState(doc)
      d.richBase = text
    }
    d.mode = 'rich'
    d.invalidate()
    d.scroll.source = srcScroller.scrollTop
    await show(d)
    // caret: find the block that contains the source line
    const info = d.info
    let lineNo = (info.prefix.match(/\r\n|\r|\n/g) || []).length
    let index = 0
    for (let i = 0; i < info.srcs.length; i++) {
      const lines = (info.srcs[i].match(/\r\n|\r|\n/g) || []).length
      if (line <= lineNo + lines) { index = i; break }
      lineNo += lines + (info.gaps[i].match(/\r\n|\r|\n/g) || []).length
      index = i + 1
    }
    const pmDoc = rich.state.doc
    const nodeIndex = Math.min(index, pmDoc.childCount - 1)
    const node = pmDoc.child(nodeIndex)
    rich.placeCaretAtBlock(nodeIndex)
    if (node.isTextblock && info.srcs[index] != null) {
      const srcLines = info.srcs[index].split(/\r\n|\r|\n/)
      const lineInBlock = line - lineNo
      const lineText = srcLines[lineInBlock] || ''
      const probe = lineText.slice(0, col).replace(/[*_`~#>[\]()!\\]|\s*$/g, '').slice(-10)
      const hay = node.textContent
      const at = probe ? hay.indexOf(probe) : -1
      if (at >= 0) {
        let start = 0
        for (let i = 0; i < nodeIndex; i++) start += pmDoc.child(i).nodeSize
        const pos = posInBlock(node, start, at + probe.length)
        try { rich.view.dispatch(rich.state.tr.setSelection(TextSelection.create(rich.state.doc, pos))) } catch {}
      }
    }
    requestAnimationFrame(() => {
      const coords = rich.view.coordsAtPos(rich.state.selection.head)
      const r = richScroller.getBoundingClientRect()
      if (coords.top < r.top || coords.bottom > r.bottom) richScroller.scrollTop += coords.top - r.top - r.height / 3
    })
  }
  focusEditor()
  tabbar.render()
  updateWindow()
  persistSoon()
}

// ------------------------------------------------------------------ images & links

editorCtx.storeImage = async (data, mime, name) => {
  const d = active
  if (!d) return null
  const dir = d.path ? dirname(d.path) : `${appSupport}/untitled/${d.id}`
  try {
    const res = await bridge.saveImage({ dir, base64: toBase64(data), mime, name })
    if (!d.path) { d.tempAssets.push(res.path); return res.path }
    return relativePath(dirname(d.path), res.path)
  } catch (e: any) {
    toast('图片保存失败：' + (e?.message || e))
    return null
  }
}

editorCtx.pickImages = async () => {
  const paths = await bridge.openDialog({ images: true, multiple: true })
  for (const p of paths) {
    try {
      const res = await fetch(localURL(p))
      const buf = await res.arrayBuffer()
      const src = await editorCtx.storeImage(buf, res.headers.get('content-type') || '', basename(p))
      if (src && active?.mode === 'rich') rich.run((state, dispatch) => {
        dispatch?.(state.tr.replaceSelectionWith(state.schema.nodes.image.create({ src, alt: stripExt(basename(p)).replace(/\.\w+$/, '') }), false).scrollIntoView())
        return true
      })
    } catch {}
  }
}

editorCtx.openLink = (href: string) => {
  if (!href) return
  if (href.startsWith('#')) {
    const target = decodeURIComponent(href.slice(1)).toLowerCase()
    const heads = [...richHost.querySelectorAll('h1,h2,h3,h4,h5,h6')] as HTMLElement[]
    const slug = (s: string) => s.trim().toLowerCase().replace(/[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '').replace(/\s+/g, '-')
    const el = heads.find(e => slug(e.textContent || '') === target || (e.textContent || '').trim().toLowerCase() === target)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) { bridge.openExternal(href); return }
  let p = href.replace(/^file:\/\//i, '').split('#')[0]
  try { p = decodeURIComponent(p) } catch {}
  if (!p.startsWith('/')) {
    if (!active?.path) return
    p = joinPath(dirname(active.path), p)
  }
  if (/\.(md|markdown|mdown|mkd|txt)$/i.test(p)) openPath(p)
  else bridge.openExternal('file://' + p)
}

// ------------------------------------------------------------------ external changes

let checking = false
async function checkExternal() {
  if (checking) return
  checking = true
  try {
    const list = docs.filter(d => d.path)
    if (!list.length) return
    const stats = await bridge.stat(list.map(d => d.path!))
    for (let i = 0; i < list.length; i++) {
      const d = list[i], st = stats[i]
      if (!st.exists) { d.missing = true; continue }
      d.missing = false
      if (!d.mtime || st.mtime === d.mtime) continue
      let f
      try { f = await bridge.readFile(d.path!) } catch { continue }
      d.mtime = f.mtime
      if (f.text === d.diskText) continue
      if (d === active) stash(d)
      d.computeDirty()
      if (!d.dirty) await reload(d, f.text)
      else { d.conflict = true; (d as any).externalText = f.text }
    }
    tabbar.render()
    updateBanner()
  } finally {
    checking = false
  }
}

async function reload(d: Doc, text: string) {
  const mode = d.mode
  const scroll = d === active ? (mode === 'rich' ? richScroller.scrollTop : srcScroller.scrollTop) : null
  const sel = d === active && mode === 'rich' ? rich.state.selection.from : null
  d.load(text, makePM)
  d.diskText = text
  d.dirty = false
  d.conflict = false
  if (mode === 'source' && source) {
    d.mode = 'source'
    const norm = text.replace(/\r\n?/g, '\n')
    d.sourceBase = { orig: text, norm }
    d.cm = source.createState(norm)
  } else d.mode = 'rich'
  if (sel != null && d.pm) {
    try { d.pm = d.pm.apply(d.pm.tr.setSelection(TextSelection.near(d.pm.doc.resolve(Math.min(sel, d.pm.doc.content.size))))) } catch {}
  }
  if (d === active) {
    await show(d)
    if (scroll != null) (mode === 'rich' ? richScroller : srcScroller).scrollTop = scroll
  }
}

function updateBanner() {
  const d = active
  banner.classList.remove('show')
  if (!d) return
  const btn = (label: string, fn: () => void) => { const b = h('button', {}, label); b.addEventListener('click', fn); return b }
  if (d.conflict) {
    banner.replaceChildren(
      h('span', { class: 'msg' }, `「${d.fileName}」已在别处被修改，而这里还有未保存的改动。`),
      btn('载入磁盘上的版本', async () => { await reload(d, (d as any).externalText ?? d.diskText ?? ''); tabbar.render(); updateWindow(); updateBanner() }),
      btn('保留我的版本', () => { d.diskText = (d as any).externalText ?? d.diskText; d.conflict = false; d.computeDirty(); tabbar.render(); updateWindow(); updateBanner() }),
    )
    banner.classList.add('show')
  } else if (d.missing) {
    banner.replaceChildren(
      h('span', { class: 'msg' }, `「${d.fileName}」已被移动或删除。保存会在原位置重新创建它。`),
      btn('另存为…', () => save(d, true)),
    )
    banner.classList.add('show')
  }
}

// ------------------------------------------------------------------ sidebar & folder

function toggleSidebar(force?: boolean) {
  const show = force ?? !document.body.classList.contains('show-sidebar')
  document.body.classList.toggle('show-sidebar', show)
  prefs.showSidebar = show
  if (show) sidebar.render()
  tabbar.render()
  updateWindow()
  persistSoon()
}

async function setFolder(path: string | null) {
  prefs.folder = path
  await sidebar.setRoot(path)
  toggleSidebar(!!path || document.body.classList.contains('show-sidebar'))
  persistSoon()
}

resizer.addEventListener('mousedown', e => {
  e.preventDefault()
  const move = (ev: MouseEvent) => {
    prefs.sidebarWidth = Math.max(160, Math.min(480, ev.clientX))
    document.documentElement.style.setProperty('--sidebar-w', prefs.sidebarWidth + 'px')
    resizer.style.left = prefs.sidebarWidth + 'px'
  }
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); persistSoon(); tabbar.reportRegions() }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
})

function applyLayoutPrefs() {
  document.documentElement.style.setProperty('--sidebar-w', prefs.sidebarWidth + 'px')
  resizer.style.left = prefs.sidebarWidth + 'px'
  document.documentElement.style.setProperty('--editor-size', prefs.fontSize + 'px')
  document.documentElement.style.setProperty('--source-size', (prefs.fontSize * 0.9).toFixed(1) + 'px')
}

function zoom(delta: number | null) {
  prefs.fontSize = delta == null ? 16 : Math.max(12, Math.min(28, prefs.fontSize + delta))
  applyLayoutPrefs()
  toast(`字号 ${prefs.fontSize}`)
  bridge.savePrefs(prefsJSON())
}

// ------------------------------------------------------------------ session

function prefsJSON() {
  return { autosave: prefs.autosave, fontSize: prefs.fontSize, lastDir: prefs.lastDir }
}

function sessionJSON(): string {
  stash(active)
  return JSON.stringify({
    version: 1,
    tabs: docs.map(d => {
      d.computeDirty()
      return {
        path: d.path,
        mode: d.mode,
        dirty: d.dirty,
        text: d.dirty || !d.path ? d.text() : undefined,
        untitledNo: d.untitledNo,
        bom: d.bom,
        tempAssets: d.tempAssets,
        scroll: d.scroll,
        sel: d.mode === 'rich' && d.pm ? { anchor: d.pm.selection.anchor, head: d.pm.selection.head } : null,
      }
    }),
    active: active ? docs.indexOf(active) : 0,
    closed: closedStack,
    folder: prefs.folder,
    sidebar: document.body.classList.contains('show-sidebar'),
    sidebarWidth: prefs.sidebarWidth,
  })
}

const persistSoon = debounce(() => { if (!quitting) bridge.saveSession(sessionJSON()) }, 1000)

async function restore(session: any) {
  if (!session || !Array.isArray(session.tabs)) return
  closedStack = Array.isArray(session.closed) ? session.closed : []
  prefs.sidebarWidth = session.sidebarWidth || prefs.sidebarWidth
  for (const t of session.tabs) {
    let d: Doc | null = null
    if (t.path) {
      let f: any = null
      try { f = await bridge.readFile(t.path) } catch {}
      if (!f && t.text == null) continue
      const text = t.dirty && t.text != null ? t.text : f ? f.text : t.text
      d = createDoc(text, t.path)
      d.bom = f ? f.bom : !!t.bom
      d.diskText = f ? f.text : null
      d.mtime = f ? f.mtime : 0
      d.missing = !f
    } else {
      d = createDoc(t.text || '')
      d.untitledNo = t.untitledNo || 1
      d.tempAssets = t.tempAssets || []
    }
    if (t.sel && d.pm) {
      try { d.pm = rich.createState(d.pm.doc, t.sel) } catch {}
    }
    d.scroll = t.scroll || d.scroll
    d.computeDirty()
    if (t.mode === 'source') {
      d.mode = 'source'
      d.sourceBase = { orig: d.text(), norm: d.text().replace(/\r\n?/g, '\n') }
    }
    docs.push(d)
  }
  if (session.folder) {
    prefs.folder = session.folder
    await sidebar.setRoot(session.folder)
  }
  if (session.sidebar) document.body.classList.add('show-sidebar')
  return typeof session.active === 'number' ? session.active : 0
}

// ------------------------------------------------------------------ export

async function exportAs(kind: 'pdf' | 'html' | 'docx' | 'png', target?: string) {
  const d = active
  if (!d) return
  stash(d)
  const text = d.text()
  const title = stripExt(suggestName(d))
  const path = target || await bridge.saveDialog({ name: title + '.' + kind, dir: d.path ? dirname(d.path) : prefs.lastDir || undefined, ext: kind })
  if (!path) return
  toast('正在导出…', 60000)
  try {
    const docDir = d.path ? dirname(d.path) : null
    if (kind === 'docx') {
      const { exportDocx } = await import('./export/word')
      const bytes = await exportDocx(text, { title, docDir })
      await bridge.writeBinary(path, toBase64(bytes))
    } else {
      const { buildStandaloneHTML } = await import('./export/html')
      const purpose = kind === 'png' ? 'image' : kind === 'pdf' ? 'pdf' : 'html'
      const html = await buildStandaloneHTML(text, { title, docDir, purpose, width: kind === 'png' ? 750 : undefined })
      if ((window as any).__jdDebug) bridge.log(`export html built (${html.length} chars)`)
      if (kind === 'html') await bridge.writeFile(path, html, false)
      else if (kind === 'pdf') await bridge.exportPDF({ html, path })
      else {
        const files = await bridge.exportImage({ html, path, width: 750 })
        if (files.length > 1) { toast(`已导出 ${files.length} 张长图`); return }
      }
    }
    toast('已导出：' + basename(path))
  } catch (e: any) {
    toastEl.classList.remove('show')
    bridge.alert({ message: '导出失败', info: String(e?.message || e), buttons: ['好'], style: 'warning' })
  }
}

// ------------------------------------------------------------------ commands

const FORMAT = new Set(['bold', 'italic', 'strike', 'code', 'link', 'heading', 'quote', 'ul', 'ol', 'task', 'codeblock', 'mathblock',
  'mathinline', 'mermaid', 'table', 'hr', 'toc', 'footnote', 'frontmatter', 'callout', 'html', 'moveUp', 'moveDown', 'undo', 'redo'])

const commands: Record<string, (arg?: any) => any> = {
  new: () => newDoc(),
  open: async () => { for (const p of await bridge.openDialog({ multiple: true })) await openPath(p) },
  openFolder: async () => { const [p] = await bridge.openDialog({ folder: true }); if (p) setFolder(p) },
  openPaths: async (items: { path: string; dir: boolean }[]) => {
    for (const it of items) {
      if (it.dir) await setFolder(it.path)
      else await openPath(it.path)
    }
  },
  save: () => active && save(active),
  saveAs: () => active && save(active, true),
  close: () => active && closeDoc(active),
  reopenClosed: () => reopenClosed(),
  print: () => exportAs('pdf'),
  exportPDF: () => exportAs('pdf'),
  exportHTML: () => exportAs('html'),
  exportWord: () => exportAs('docx'),
  exportImage: () => exportAs('png'),
  toggleMode: () => toggleMode(),
  toggleSidebar: () => toggleSidebar(),
  find: () => findbar.show(false),
  findReplace: () => findbar.show(true),
  findNext: () => findbar.step(1),
  findPrev: () => findbar.step(-1),
  nextTab: () => cycle(1),
  prevTab: () => cycle(-1),
  selectTab: (n: number) => { const d = n >= 9 ? docs[docs.length - 1] : docs[n - 1]; if (d) activate(d) },
  zoomIn: () => zoom(1),
  zoomOut: () => zoom(-1),
  zoomReset: () => zoom(null),
  toggleAutosave: () => { prefs.autosave = !prefs.autosave; bridge.savePrefs(prefsJSON()); updateWindow(); toast(prefs.autosave ? '已开启自动保存' : '已关闭自动保存'); if (prefs.autosave) autosave() },
  reveal: () => active?.path && bridge.reveal(active.path),
  focus: () => checkExternal(),
  fullscreen: (on: boolean) => { document.body.classList.toggle('fullscreen', !!on); tabbar.reportRegions() },
  prepareQuit: async () => {
    persistSoon.cancel()
    try { await bridge.saveSession(sessionJSON()) } finally {
      quitting = true
      bridge.quitReady()
    }
  },
  setDefaultApp: async () => { if (await bridge.setDefaultApp()) toast('已设为 .md 文件的默认打开方式') },
}

function cycle(dir: number) {
  if (!active || docs.length < 2) return
  const i = docs.indexOf(active)
  activate(docs[(i + dir + docs.length) % docs.length])
}

function dispatch(cmd: string, arg?: any) {
  if (FORMAT.has(cmd)) {
    if (!active) return
    if (active.mode === 'rich') rich.command(cmd, arg)
    else source?.command(cmd, arg)
    return
  }
  const fn = commands[cmd]
  if (fn) return fn(arg)
  console.warn('unknown command', cmd)
}

/** Native side: the click that activated the window never reached the page — deliver it. */
function replayClick(x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  if (!el || !el.closest('.titlebar')) return false
  const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail: 1, view: window }
  el.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }))
  el.dispatchEvent(new MouseEvent('mouseup', init))
  el.dispatchEvent(new MouseEvent('click', init))
  return true
}

;(window as any).__jd = { dispatch, docs, exportAs, openPath, replayClick, get appSupport() { return appSupport }, get active() { return active }, rich, get source() { return source }, sessionJSON }

// keyboard shortcuts that belong to the page rather than the menu bar
window.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); return }
  if (e.metaKey && !e.altKey && !e.ctrlKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); commands.selectTab(+e.key); return }
  if (e.key === 'Escape' && findbar.open && !findbar.el.contains(document.activeElement)) { findbar.close(); return }
  if (!isNative && e.metaKey) {
    const k = e.key.toLowerCase()
    const map: Record<string, string> = { s: e.shiftKey ? 'saveAs' : 'save', e: 'toggleMode', f: e.altKey ? 'findReplace' : 'find', n: 'new', w: 'close', o: e.shiftKey ? 'openFolder' : 'open', p: 'print', t: e.shiftKey ? 'reopenClosed' : '', g: e.shiftKey ? 'findPrev' : 'findNext', '\\': 'toggleSidebar' }
    if (map[k]) { e.preventDefault(); dispatch(map[k]) }
  }
}, true)

window.addEventListener('focus', () => { checkExternal() })
document.addEventListener('dragover', e => e.preventDefault())
document.addEventListener('drop', e => { if (!(e.target as HTMLElement).closest('.ProseMirror, .cm-editor')) e.preventDefault() })

// ------------------------------------------------------------------ boot

async function boot() {
  const init = await bridge.ready()
  appSupport = init.appSupport
  if ((init as any).debugInput) {
    // DebugInput: record which title-bar element every click reaches
    for (const type of ['mousedown', 'click']) {
      tabbar.el.addEventListener(type, e => {
        const t = e.target as HTMLElement
        const el = t.closest('.tab, .tb-btn') as HTMLElement | null
        bridge.log(`${type} ${el ? el.className : 'titlebar'} trusted=${e.isTrusted} at ${Math.round((e as MouseEvent).clientX)},${Math.round((e as MouseEvent).clientY)}`)
      }, true)
    }
  }
  setHomeDir(init.home)
  Object.assign(prefs, { autosave: !!init.prefs?.autosave, fontSize: init.prefs?.fontSize || 16, lastDir: init.prefs?.lastDir || '' })
  let activeIndex = 0
  try { activeIndex = (await restore(init.session)) || 0 } catch (e) { console.error(e) }
  applyLayoutPrefs()
  if (!docs.length) docs.push(createDoc())
  const target = docs[Math.min(activeIndex, docs.length - 1)]
  await activate(target)
  if (init.openPaths?.length) await commands.openPaths(init.openPaths.map((p: any) => (typeof p === 'string' ? { path: p, dir: false } : p)))
  tabbar.render()
  updateWindow()
  focusEditor()
  document.body.classList.add('ready')
}

boot()
