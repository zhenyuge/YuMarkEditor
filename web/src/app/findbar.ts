import { icons } from '../icons'
import { h } from '../util'
import type { FindQuery } from '../rich/editor'

export interface Searchable {
  setQuery(q: FindQuery | null): void
  findNext(): boolean
  findPrev(): boolean
  replaceNext(): boolean
  replaceAll(): boolean
  matchInfo(): { current: number; total: number }
  selectedText(): string
  focus(): void
}

export class FindBar {
  el: HTMLElement
  find: HTMLInputElement
  replace: HTMLInputElement
  count: HTMLElement
  replaceRow: HTMLElement
  opts = { caseSensitive: false, regexp: false, wholeWord: false }
  open = false

  constructor(parent: HTMLElement, private target: () => Searchable) {
    this.find = h('input', { class: 'fb-input', placeholder: '查找', spellcheck: 'false' }) as HTMLInputElement
    this.replace = h('input', { class: 'fb-input', placeholder: '替换为', spellcheck: 'false' }) as HTMLInputElement
    this.count = h('span', { class: 'fb-count' })
    const toggle = (key: keyof FindBar['opts'], icon: string, title: string) => {
      const b = h('button', { class: 'fb-toggle', title, html: icon })
      b.addEventListener('mousedown', e => e.preventDefault())
      b.addEventListener('click', () => { this.opts[key] = !this.opts[key]; b.classList.toggle('on', this.opts[key]); this.apply(true) })
      return b
    }
    const btn = (icon: string | null, title: string, fn: () => void, label?: string) => {
      const b = h('button', { class: icon ? 'fb-btn' : 'fb-text-btn', title, html: icon || '' }, label || '')
      b.addEventListener('mousedown', e => e.preventDefault())
      b.addEventListener('click', fn)
      return b
    }
    this.replaceRow = h('div', { class: 'fb-row fb-replace' },
      this.replace,
      btn(null, '替换当前匹配', () => this.doReplace(), '替换'),
      btn(null, '全部替换', () => this.doReplaceAll(), '全部替换'))
    this.el = h('div', { class: 'findbar', style: { display: 'none' } },
      h('div', { class: 'fb-row' },
        this.find,
        this.count,
        toggle('caseSensitive', icons.caseSensitive, '区分大小写'),
        toggle('wholeWord', icons.wholeWord, '全字匹配'),
        toggle('regexp', icons.regex, '正则表达式'),
        btn(icons.up, '上一个 (⇧⌘G)', () => this.step(-1)),
        btn(icons.down, '下一个 (⌘G)', () => this.step(1)),
        btn(icons.close, '关闭 (Esc)', () => this.close())),
      this.replaceRow)
    parent.append(this.el)

    this.find.addEventListener('input', () => this.apply(true))
    this.replace.addEventListener('input', () => this.apply(false))
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); this.close() }
      else if (e.key === 'Enter' && e.target === this.find) { e.preventDefault(); this.step(e.shiftKey ? -1 : 1) }
      else if (e.key === 'Enter' && e.target === this.replace) { e.preventDefault(); e.metaKey || e.altKey ? this.doReplaceAll() : this.doReplace() }
      else if (e.key === 'g' && e.metaKey) { e.preventDefault(); this.step(e.shiftKey ? -1 : 1) }
    }
    this.find.addEventListener('keydown', keys)
    this.replace.addEventListener('keydown', keys)
  }

  query(): FindQuery {
    return { search: this.find.value, replace: this.replace.value, ...this.opts }
  }

  show(withReplace: boolean) {
    this.open = true
    this.el.style.display = ''
    this.replaceRow.style.display = withReplace ? '' : 'none'
    const sel = this.target().selectedText()
    if (sel && !sel.includes('\n') && sel.length < 200) this.find.value = sel
    this.find.focus()
    this.find.select()
    this.apply(false)
  }

  close() {
    if (!this.open) return
    this.open = false
    this.el.style.display = 'none'
    const t = this.target()
    t.setQuery(null)
    t.focus()
  }

  /** re-apply the query to the (possibly different) current editor */
  reapply() {
    if (this.open) this.apply(false)
  }

  apply(jump: boolean) {
    const t = this.target()
    const q = this.query()
    let valid = true
    if (q.regexp && q.search) { try { new RegExp(q.search) } catch { valid = false } }
    this.find.classList.toggle('invalid', !valid)
    t.setQuery(q.search && valid ? q : null)
    if (jump && q.search && valid) t.findNext()
    this.updateCount()
    if (document.activeElement !== this.replace) this.find.focus()
  }

  step(dir: 1 | -1) {
    if (!this.open) { this.show(false); return }
    const t = this.target()
    if (!this.find.value) return
    t.setQuery(this.query())
    dir > 0 ? t.findNext() : t.findPrev()
    this.updateCount()
  }

  doReplace() {
    const t = this.target()
    t.setQuery(this.query())
    t.replaceNext()
    this.updateCount()
  }

  doReplaceAll() {
    const t = this.target()
    t.setQuery(this.query())
    t.replaceAll()
    this.updateCount()
  }

  updateCount() {
    if (!this.find.value) { this.count.textContent = ''; return }
    const { current, total } = this.target().matchInfo()
    this.count.textContent = total ? `${current || '–'}/${total}` : '无结果'
    this.count.classList.toggle('none', !total)
  }
}
