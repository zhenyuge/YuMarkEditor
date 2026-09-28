// A document tab: file identity, disk baseline and editor states.
import type { EditorState as PMState } from 'prosemirror-state'
import type { EditorState as CMState } from '@codemirror/state'
import { parseMarkdown, detectEol, type SourceInfo } from '../md/parse'
import { composeMarkdown } from '../md/compose'
import { basename, stripExt, uid } from '../util'

export type Mode = 'rich' | 'source'

export class Doc {
  id = uid()
  path: string | null = null
  mode: Mode = 'rich'
  bom = false
  eol: '\n' | '\r\n' = '\n'
  /** exact text last read from / written to disk; null for never-saved documents */
  diskText: string | null = null
  mtime = 0
  info!: SourceInfo
  pm: PMState | null = null
  cm: CMState | null = null
  /** text the rich state corresponds to (to skip re-parsing after a no-op trip through source mode) */
  richBase: string | null = null
  /** the exact text handed to the source editor, and its \n-normalised form */
  sourceBase: { orig: string; norm: string } | null = null
  dirty = false
  scroll = { rich: 0, source: 0 }
  untitledNo = 1
  missing = false
  conflict = false
  /** images pasted before the document had a location */
  tempAssets: string[] = []
  /** cached composed text, invalidated on every edit */
  private textCache: string | null = null

  get title() {
    if (this.path) return stripExt(basename(this.path))
    return this.untitledNo > 1 ? `未命名 ${this.untitledNo}` : '未命名'
  }

  get fileName() {
    return this.path ? basename(this.path) : this.title + '.md'
  }

  invalidate() {
    this.textCache = null
  }

  /** Replace the whole content (on open / reload); both editors start fresh. */
  load(text: string, makePM: (doc: any) => PMState) {
    const { doc, info } = parseMarkdown(text)
    this.info = info
    if (info.bom) this.bom = true
    this.eol = text ? detectEol(text) : this.eol
    this.pm = makePM(doc)
    this.richBase = info.bom ? text.slice(1) : text
    this.cm = null
    this.sourceBase = null
    this.textCache = this.richBase
  }

  /** Current file text (without BOM). */
  text(): string {
    if (this.textCache != null) return this.textCache
    let t: string
    if (this.mode === 'rich') {
      t = composeMarkdown(this.pm!.doc, this.info).text
    } else if (!this.cm) {
      t = this.sourceBase?.orig ?? this.richBase ?? ''
    } else {
      const norm = this.cm.doc.toString()
      if (this.sourceBase && norm === this.sourceBase.norm) t = this.sourceBase.orig
      else t = this.eol === '\r\n' ? norm.replace(/\n/g, '\r\n') : norm
    }
    this.textCache = t
    return t
  }

  isPristine() {
    return !this.path && !this.dirty && this.text() === '' && !this.tempAssets.length
  }

  /** After a successful save make the saved text the new baseline. */
  markSaved(text: string, mtime: number) {
    this.diskText = text
    this.mtime = mtime
    this.dirty = false
    this.conflict = false
    this.missing = false
    if (this.mode === 'rich' && this.pm) {
      this.info = composeMarkdown(this.pm.doc, this.info).info
      this.richBase = text
    }
    if (this.mode === 'source') this.sourceBase = { orig: text, norm: text.replace(/\r\n?/g, '\n') }
    this.textCache = text
  }

  computeDirty() {
    const base = this.diskText ?? ''
    this.dirty = this.text() !== base || (!this.path && this.tempAssets.length > 0)
    return this.dirty
  }
}
