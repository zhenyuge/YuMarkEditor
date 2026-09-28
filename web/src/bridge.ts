// JS <-> native bridge. In the app every call is a WKScriptMessageHandlerWithReply
// round-trip; in a plain browser (tests) a small in-memory mock stands in.

export interface FileRead { text: string; bom: boolean; mtime: number }
export interface DirEntry { name: string; path: string; dir: boolean }
export interface MenuItem {
  id?: string
  title?: string
  enabled?: boolean
  checked?: boolean
  separator?: boolean
  submenu?: MenuItem[]
}

export interface Bridge {
  ready(): Promise<{ session: any; prefs: any; openPaths: string[]; appSupport: string; home: string; debugInput?: boolean }>
  readFile(path: string): Promise<FileRead>
  writeFile(path: string, text: string, bom: boolean): Promise<{ mtime: number }>
  writeBinary(path: string, base64: string): Promise<void>
  stat(paths: string[]): Promise<{ path: string; exists: boolean; mtime: number; dir: boolean }[]>
  listDir(path: string): Promise<DirEntry[]>
  openDialog(opts: { folder?: boolean; multiple?: boolean; images?: boolean }): Promise<string[]>
  saveDialog(opts: { name: string; dir?: string; ext?: string }): Promise<string | null>
  createFile(path: string, text?: string): Promise<string>
  createDir(path: string): Promise<string>
  rename(path: string, newName: string): Promise<string>
  duplicate(path: string): Promise<string>
  trash(path: string): Promise<void>
  moveFile(from: string, to: string): Promise<string>
  reveal(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  saveImage(opts: { dir: string; base64: string; mime: string; name?: string }): Promise<{ path: string }>
  confirmClose(name: string): Promise<'save' | 'discard' | 'cancel'>
  alert(opts: { message: string; info?: string; buttons: string[]; style?: 'warning' | 'info' }): Promise<number>
  menu(items: MenuItem[], x: number, y: number): Promise<string | null>
  setWindow(opts: { title: string; path: string | null; dirty: boolean }): Promise<void>
  setDragRegions(rects: number[][]): Promise<void>
  setMenuState(state: Record<string, unknown>): Promise<void>
  saveSession(json: string): Promise<void>
  savePrefs(prefs: any): Promise<void>
  quitReady(): Promise<void>
  exportPDF(opts: { html: string; path: string }): Promise<void>
  exportImage(opts: { html: string; path: string; width: number }): Promise<string[]>
  setDefaultApp(): Promise<boolean>
  log(msg: string): Promise<void>
}

type Wk = { postMessage(msg: unknown): Promise<unknown> }
const wk: Wk | undefined = (window as any).webkit?.messageHandlers?.bridge

export const isNative = !!wk

function call(cmd: string, args: unknown = {}): Promise<any> {
  return wk!.postMessage({ cmd, args })
}

const nativeBridge = new Proxy({} as Bridge, {
  get: (_t, cmd: string) => (...args: unknown[]) => call(cmd, args.length > 1 ? args : args[0] ?? {}),
})

// ------------------------------------------------------------------ mock
function mockBridge(): Bridge {
  const fs = new Map<string, { text: string; mtime: number }>()
  const w = window as any
  const seed: Record<string, string> = w.__MOCK_FILES__ || {}
  for (const [p, t] of Object.entries(seed)) fs.set(p, { text: t, mtime: 1 })
  const log: any[] = (w.__MOCK_LOG__ = [])
  const rec = (cmd: string, args: unknown) => log.push({ cmd, args })
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'
  return {
    async ready() {
      return { session: w.__MOCK_SESSION__ || null, prefs: w.__MOCK_PREFS__ || {}, openPaths: w.__MOCK_OPEN__ || [], appSupport: '/mock/support', home: '/mock' }
    },
    async readFile(path) {
      const f = fs.get(path)
      if (!f) throw new Error('not found: ' + path)
      return { text: f.text, bom: false, mtime: f.mtime }
    },
    async writeFile(path, text) { rec('writeFile', { path, text }); fs.set(path, { text, mtime: Date.now() }); return { mtime: Date.now() } },
    async writeBinary(path) { rec('writeBinary', { path }) },
    async stat(paths) { return paths.map(p => ({ path: p, exists: fs.has(p), mtime: fs.get(p)?.mtime || 0, dir: false })) },
    async listDir(path) {
      const out = new Map<string, DirEntry>()
      for (const p of fs.keys()) {
        if (!p.startsWith(path + '/')) continue
        const rest = p.slice(path.length + 1)
        const name = rest.split('/')[0]
        out.set(name, { name, path: path + '/' + name, dir: rest.includes('/') })
      }
      return [...out.values()]
    },
    async openDialog() { return w.__MOCK_DIALOG__ || [] },
    async saveDialog(o) { rec('saveDialog', o); return w.__MOCK_SAVE_PATH__ ?? '/mock/Untitled.md' },
    async createFile(path, text = '') { fs.set(path, { text, mtime: Date.now() }); return path },
    async createDir(path) { return path },
    async rename(path, name) { const np = dirOf(path) + '/' + name; const f = fs.get(path); if (f) { fs.delete(path); fs.set(np, f) } return np },
    async duplicate(path) { const np = path.replace(/(\.\w+)?$/, ' 副本$1'); fs.set(np, { ...fs.get(path)! }); return np },
    async trash(path) { fs.delete(path) },
    async moveFile(from, to) { const f = fs.get(from); if (f) { fs.delete(from); fs.set(to, f) } return to },
    async reveal() {},
    async openExternal(url) { rec('openExternal', url) },
    async saveImage(o) { rec('saveImage', o); return { path: o.dir + '/assets/image.webp' } },
    async confirmClose() { return w.__MOCK_CONFIRM__ || 'discard' },
    async alert() { return 0 },
    async menu(items) { rec('menu', items); return w.__MOCK_MENU_PICK__ ?? null },
    async setWindow(o) { document.title = o.title },
    async setDragRegions() {},
    async setMenuState() {},
    async saveSession(json) { w.__SESSION__ = json },
    async savePrefs() {},
    async quitReady() {},
    async exportPDF(o) { rec('exportPDF', o) },
    async exportImage(o) { rec('exportImage', o); return [o.path] },
    async setDefaultApp() { return true },
    async log(m) { console.log('[native]', m) },
  }
}

export const bridge: Bridge = wk ? nativeBridge : mockBridge()
