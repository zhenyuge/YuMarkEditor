import { icons } from '../icons'
import { bridge } from '../bridge'
import { h } from '../util'
import type { Doc } from './doc'

export interface TabBarHost {
  docs(): Doc[]
  active(): Doc | null
  activate(doc: Doc): void
  close(doc: Doc): void
  newDoc(): void
  contextMenu(doc: Doc, x: number, y: number): void
  reorder(from: number, to: number): void
  toggleSidebar(): void
  sidebarVisible(): boolean
}

export class TabBar {
  el: HTMLElement
  strip: HTMLElement
  addBtn: HTMLElement
  sideBtn: HTMLElement
  private drag: { doc: Doc; startX: number; el: HTMLElement; moved: boolean; index: number } | null = null

  constructor(root: HTMLElement, private host: TabBarHost) {
    this.sideBtn = h('button', { class: 'tb-btn sidebar-toggle', title: '显示/隐藏侧边栏 (⌘\\)', html: icons.sidebar })
    this.sideBtn.addEventListener('click', () => host.toggleSidebar())
    this.strip = h('div', { class: 'tab-strip' })
    this.addBtn = h('button', { class: 'tb-btn tab-add', title: '新建 (⌘N)', html: icons.plus })
    this.addBtn.addEventListener('click', () => host.newDoc())
    this.el = h('div', { class: 'titlebar' }, h('div', { class: 'traffic-space' }), this.sideBtn, this.strip, this.addBtn, h('div', { class: 'drag-fill' }))
    root.append(this.el)
    this.strip.addEventListener('wheel', e => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { this.strip.scrollLeft += e.deltaY; e.preventDefault() }
    }, { passive: false })
    window.addEventListener('resize', () => this.reportRegions())
  }

  render() {
    const docs = this.host.docs()
    const active = this.host.active()
    this.sideBtn.classList.toggle('on', this.host.sidebarVisible())
    const els = docs.map((d, i) => {
      const close = h('span', { class: 'tab-close', title: '关闭 (⌘W)', html: icons.close })
      close.addEventListener('mousedown', e => e.stopPropagation())
      close.addEventListener('click', e => { e.stopPropagation(); this.host.close(d) })
      const tab = h('div', {
        class: 'tab' + (d === active ? ' active' : '') + (d.dirty ? ' dirty' : '') + (d.missing ? ' missing' : ''),
        title: d.path || d.title,
        'data-id': d.id,
      }, h('span', { class: 'tab-title' }, d.title), h('span', { class: 'tab-state' }, h('span', { class: 'tab-dot' }), close))
      tab.addEventListener('mousedown', e => {
        if (e.button === 1) { e.preventDefault(); this.host.close(d); return }
        if (e.button !== 0) return
        this.host.activate(d)
        this.drag = { doc: d, startX: e.clientX, el: tab, moved: false, index: i }
        const move = (ev: MouseEvent) => this.onDrag(ev)
        const up = () => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          this.endDrag()
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      })
      tab.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault() })
      tab.addEventListener('contextmenu', e => { e.preventDefault(); this.host.contextMenu(d, e.clientX, e.clientY) })
      tab.addEventListener('dblclick', e => e.stopPropagation())
      return tab
    })
    this.strip.replaceChildren(...els)
    const act = this.strip.querySelector('.tab.active') as HTMLElement | null
    if (act) {
      const l = act.offsetLeft, r = l + act.offsetWidth
      if (l < this.strip.scrollLeft) this.strip.scrollLeft = l - 8
      else if (r > this.strip.scrollLeft + this.strip.clientWidth) this.strip.scrollLeft = r - this.strip.clientWidth + 8
    }
    requestAnimationFrame(() => this.reportRegions())
  }

  private onDrag(e: MouseEvent) {
    const d = this.drag
    if (!d) return
    const dx = e.clientX - d.startX
    if (!d.moved && Math.abs(dx) < 5) return
    d.moved = true
    d.el.classList.add('dragging')
    d.el.style.transform = `translateX(${dx}px)`
    // compute target slot
    const tabs = [...this.strip.querySelectorAll('.tab')] as HTMLElement[]
    const center = d.el.getBoundingClientRect().left + d.el.offsetWidth / 2
    let target = d.index
    tabs.forEach((t, i) => {
      if (t === d.el) return
      const r = t.getBoundingClientRect()
      if (i > d.index && center > r.left + r.width / 2) target = i
      if (i < d.index && center < r.left + r.width / 2 && target === d.index) target = i
    })
    tabs.forEach((t, i) => {
      if (t === d.el) return
      let shift = 0
      if (target > d.index && i > d.index && i <= target) shift = -d.el.offsetWidth
      if (target < d.index && i < d.index && i >= target) shift = d.el.offsetWidth
      t.style.transform = shift ? `translateX(${shift}px)` : ''
    })
    ;(d as any).target = target
  }

  private endDrag() {
    const d = this.drag
    this.drag = null
    if (!d) return
    const target = (d as any).target
    this.strip.querySelectorAll('.tab').forEach(t => { (t as HTMLElement).style.transform = ''; t.classList.remove('dragging') })
    if (d.moved && target != null && target !== d.index) this.host.reorder(d.index, target)
    else this.render()
  }

  /** Tell the native side which parts of the title bar are buttons (everything else drags the window). */
  reportRegions() {
    const rects: number[][] = []
    const push = (el: Element) => {
      const r = el.getBoundingClientRect()
      if (r.width && r.height) rects.push([r.left, r.top, r.width, r.height])
    }
    this.el.querySelectorAll('.tab, .tb-btn').forEach(push)
    bridge.setDragRegions(rects)
  }
}
