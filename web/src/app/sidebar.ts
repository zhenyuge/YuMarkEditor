// A plain file tree: lists directories on demand, nothing is indexed or watched.
import { bridge, type DirEntry } from '../bridge'
import { icons } from '../icons'
import { basename, dirname, h } from '../util'

export interface SidebarHost {
  openFile(path: string): void
  activePath(): string | null
  renamed(from: string, to: string): void
  trashed(path: string): void
  closeFolder(): void
  changed(): void
}

const MD_RE = /\.(md|markdown|mdown|mkd|mdx|txt)$/i

export class Sidebar {
  el: HTMLElement
  tree: HTMLElement
  header: HTMLElement
  root: string | null = null
  expanded = new Set<string>()
  cache = new Map<string, DirEntry[]>()
  selected: string | null = null
  private renaming: string | null = null

  constructor(parent: HTMLElement, private host: SidebarHost) {
    this.header = h('div', { class: 'sb-header' })
    this.tree = h('div', { class: 'sb-tree', tabindex: '0' })
    this.el = h('aside', { class: 'sidebar' }, this.header, this.tree)
    parent.prepend(this.el)
    this.tree.addEventListener('contextmenu', e => {
      if ((e.target as HTMLElement).closest('.sb-item')) return
      e.preventDefault()
      if (this.root) this.menu(this.root, true, e.clientX, e.clientY)
    })
  }

  async setRoot(path: string | null) {
    this.root = path
    this.cache.clear()
    this.expanded = new Set(path ? [path] : [])
    if (path) await this.load(path)
    this.render()
  }

  async load(dir: string) {
    try {
      const list = await bridge.listDir(dir)
      list.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }) : a.dir ? -1 : 1))
      this.cache.set(dir, list.filter(e => !e.name.startsWith('.')))
    } catch {
      this.cache.set(dir, [])
    }
  }

  async refresh() {
    if (!this.root) return
    const dirs = [...this.expanded].filter(d => d === this.root || d.startsWith(this.root + '/'))
    await Promise.all(dirs.map(d => this.load(d)))
    this.render()
  }

  render() {
    this.header.replaceChildren()
    if (!this.root) {
      const open = h('button', { class: 'sb-open' }, '打开文件夹…')
      open.addEventListener('click', () => (window as any).__jd.dispatch('openFolder'))
      this.tree.replaceChildren(h('div', { class: 'sb-empty' }, h('div', {}, '没有打开文件夹'), open, h('div', { class: 'sb-hint' }, '⇧⌘O')))
      return
    }
    const btn = (icon: string, title: string, fn: () => void) => {
      const b = h('button', { class: 'sb-btn', title, html: icon })
      b.addEventListener('click', fn)
      return b
    }
    this.header.append(
      h('span', { class: 'sb-title', title: this.root }, basename(this.root) || this.root),
      btn(icons.newFile, '新建文件', () => this.createIn(this.root!, false)),
      btn(icons.newFolder, '新建文件夹', () => this.createIn(this.root!, true)),
      btn(icons.refresh, '刷新', () => this.refresh()),
      btn(icons.close, '关闭文件夹', () => this.host.closeFolder()),
    )
    const frag = document.createDocumentFragment()
    this.renderDir(this.root, 0, frag)
    this.tree.replaceChildren(frag)
    if (!this.cache.get(this.root)?.length) this.tree.append(h('div', { class: 'sb-empty small' }, '空文件夹'))
  }

  private renderDir(dir: string, depth: number, out: DocumentFragment | HTMLElement) {
    const active = this.host.activePath()
    for (const e of this.cache.get(dir) || []) {
      const isMd = !e.dir && MD_RE.test(e.name)
      const open = e.dir && this.expanded.has(e.path)
      const row = h('div', {
        class: 'sb-item' + (e.dir ? ' dir' : isMd ? ' md' : ' other') + (open ? ' open' : '') + (e.path === active ? ' active' : '') + (e.path === this.selected ? ' selected' : ''),
        style: { paddingLeft: 10 + depth * 14 + 'px' },
        title: e.path,
        'data-path': e.path,
      },
      h('span', { class: 'sb-caret', html: e.dir ? icons.chevron : '' }),
      h('span', { class: 'sb-icon', html: e.dir ? icons.folder : isMd ? icons.fileMd : icons.file }),
      this.renaming === e.path ? this.renameInput(e) : h('span', { class: 'sb-name' }, e.name))
      row.addEventListener('click', async () => {
        this.selected = e.path
        if (e.dir) {
          if (open) this.expanded.delete(e.path)
          else { this.expanded.add(e.path); if (!this.cache.has(e.path)) await this.load(e.path) }
          this.render()
        } else if (isMd) {
          this.host.openFile(e.path)
        } else {
          this.render()
        }
      })
      row.addEventListener('dblclick', () => { if (!e.dir && !isMd) bridge.openExternal('file://' + e.path) })
      row.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); this.selected = e.path; this.render(); this.menu(e.path, e.dir, ev.clientX, ev.clientY) })
      out.append(row)
      if (open) this.renderDir(e.path, depth + 1, out)
    }
  }

  private renameInput(e: DirEntry) {
    const input = h('input', { class: 'sb-rename', value: e.name, spellcheck: 'false' }) as HTMLInputElement
    let done = false
    const finish = async (ok: boolean) => {
      if (done) return
      done = true
      this.renaming = null
      const name = input.value.trim()
      if (ok && name && name !== e.name && !name.includes('/')) {
        try {
          const np = await bridge.rename(e.path, name)
          this.host.renamed(e.path, np)
          this.selected = np
          await this.load(dirname(e.path))
        } catch (err: any) {
          bridge.alert({ message: '无法重命名', info: String(err?.message || err), buttons: ['好'] })
        }
      }
      this.render()
    }
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true) }
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false) }
      ev.stopPropagation()
    })
    input.addEventListener('blur', () => finish(true))
    requestAnimationFrame(() => {
      input.focus()
      const dot = e.dir ? -1 : e.name.lastIndexOf('.')
      input.setSelectionRange(0, dot > 0 ? dot : e.name.length)
    })
    input.addEventListener('click', ev => ev.stopPropagation())
    return input
  }

  startRename(path: string) {
    this.renaming = path
    this.render()
  }

  async createIn(dir: string, folder: boolean) {
    this.expanded.add(dir)
    const base = folder ? '新建文件夹' : '未命名'
    const ext = folder ? '' : '.md'
    const existing = new Set((this.cache.get(dir) || []).map(e => e.name))
    let name = base + ext
    for (let i = 2; existing.has(name); i++) name = `${base} ${i}${ext}`
    try {
      const p = folder ? await bridge.createDir(dir + '/' + name) : await bridge.createFile(dir + '/' + name, '')
      await this.load(dir)
      this.renaming = p
      this.selected = p
      this.render()
      if (!folder) this.host.openFile(p)
    } catch (err: any) {
      bridge.alert({ message: '无法创建', info: String(err?.message || err), buttons: ['好'] })
    }
  }

  async menu(path: string, isDir: boolean, x: number, y: number) {
    const isRoot = path === this.root
    const dir = isDir ? path : dirname(path)
    const id = await bridge.menu([
      { id: 'newFile', title: '新建 Markdown 文件' },
      { id: 'newFolder', title: '新建文件夹' },
      { separator: true },
      ...(isRoot ? [] : [
        { id: 'rename', title: '重命名' },
        { id: 'duplicate', title: '创建副本' },
        { id: 'trash', title: '移到废纸篓' },
        { separator: true },
      ]),
      { id: 'reveal', title: '在访达中显示' },
      { id: 'copyPath', title: '拷贝路径' },
      ...(isRoot ? [{ separator: true }, { id: 'refresh', title: '刷新' }] : []),
    ], x, y)
    switch (id) {
      case 'newFile': return this.createIn(dir, false)
      case 'newFolder': return this.createIn(dir, true)
      case 'rename': return this.startRename(path)
      case 'duplicate':
        try { const np = await bridge.duplicate(path); await this.load(dirname(path)); this.selected = np; this.render() } catch (e: any) { bridge.alert({ message: '无法创建副本', info: String(e?.message || e), buttons: ['好'] }) }
        return
      case 'trash': {
        try {
          await bridge.trash(path)
          this.host.trashed(path)
          await this.load(dirname(path))
          this.render()
        } catch (e: any) { bridge.alert({ message: '无法移到废纸篓', info: String(e?.message || e), buttons: ['好'] }) }
        return
      }
      case 'reveal': return bridge.reveal(path)
      case 'copyPath': return navigator.clipboard?.writeText(path)
      case 'refresh': return this.refresh()
    }
  }
}
