// Minimal stroke icons (24x24 viewBox), inlined to keep the app self-contained.
const svg = (d: string, extra = '') =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`

export const icons = {
  bold: svg('<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>'),
  italic: svg('<path d="M19 4h-9M14 20H5M15 4 9 20"/>'),
  strike: svg('<path d="M16 6a4 4 0 0 0-4-2c-2.8 0-4.5 1.6-4.5 3.4 0 1.6 1 2.4 2.6 3M4 12h16M8 18a4.5 4.5 0 0 0 4 2c2.8 0 4.5-1.5 4.5-3.5 0-.8-.2-1.4-.6-2"/>'),
  code: svg('<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
  math: svg('<path d="M18 5H7l5 7-5 7h11"/>'),
  h1: svg('<path d="M4 6v12M12 6v12M4 12h8M17 10l3-2v10"/>'),
  h2: svg('<path d="M4 6v12M12 6v12M4 12h8M16.5 10a2 2 0 1 1 3.5 1.5L16 18h5"/>'),
  h3: svg('<path d="M4 6v12M12 6v12M4 12h8M16.5 8.5A2 2 0 1 1 18.5 12a2 2 0 1 1-2 3.5M18.5 12h-1"/>'),
  quote: svg('<path d="M4 7h6v6H6l-2 4zM14 7h6v6h-4l-2 4z"/>'),
  paragraph: svg('<path d="M13 4v16M17 4v16M19 4H9.5a4.5 4.5 0 0 0 0 9H13"/>'),
  ul: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  ol: svg('<path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v5M4 14.5a1.3 1.3 0 1 1 2.2 1L4 19h3"/>'),
  task: svg('<rect x="3" y="4" width="7" height="7" rx="1.5"/><path d="m4.5 17 1.8 1.8L10 15M14 7.5h7M14 17h7"/>'),
  callout: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>'),
  codeblock: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 10-2 2 2 2M14 10l2 2-2 2"/>'),
  sigma: svg('<path d="M18 7V4H6l6 8-6 8h12v-3"/>'),
  chart: svg('<rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="16" width="7" height="5" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><path d="M6.5 8v4.5a2 2 0 0 0 2 2H14M17.5 8v8"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>'),
  hr: svg('<path d="M3 12h18"/><path d="M8 7h8M8 17h8" opacity=".4"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5L5 20"/>'),
  toc: svg('<path d="M4 6h16M8 12h12M8 18h12M4 12h.01M4 18h.01"/>'),
  footnote: svg('<path d="M4 18h10M4 13h16M4 8h16"/><path d="M18 17.5h3M19.5 16v5" /><path d="M17 3v4M15 5h4" opacity=".5"/>'),
  props: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h3M7 13h3M13 9h4M13 13h4M7 17h10"/>'),
  html: svg('<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  sidebar: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>'),
  chevron: svg('<path d="m9 6 6 6-6 6"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  fileMd: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8.5 17v-4l1.75 2 1.75-2v4M15.5 13v4m-1.5-1.5 1.5 1.5 1.5-1.5"/>'),
  newFile: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>'),
  newFolder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>'),
  refresh: svg('<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>'),
  up: svg('<path d="m6 15 6-6 6 6"/>'),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  caseSensitive: svg('<path d="M3 17 7 7l4 10M4.5 13.5h5M15.5 11a2.5 2.5 0 1 1 0 6 2.5 2.5 0 0 1 0-6zm2.5 0v6"/>'),
  regex: svg('<path d="M17 3v10M12.7 5.5l8.6 5M12.7 10.5l8.6-5"/><rect x="3" y="15" width="6" height="6" rx="1"/>'),
  wholeWord: svg('<path d="M3 17h18M6 7v6h4a2 2 0 0 0 0-4H6M15 13a2 2 0 1 0 4 0v-2a2 2 0 1 0-4 0"/>'),
  external: svg('<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>'),
  check: svg('<path d="m5 12 5 5L20 7"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  edit: svg('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
}

export const calloutIcons: Record<string, string> = {
  note: icons.callout,
  info: icons.callout,
  tip: svg('<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>'),
  important: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v4M12 14h.01"/>'),
  warning: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>'),
  caution: svg('<polygon points="7.9 2 16.1 2 22 7.9 22 16.1 16.1 22 7.9 22 2 16.1 2 7.9"/><path d="M12 8v4M12 16h.01"/>'),
  danger: svg('<path d="m13 2-10 12h9l-1 8 10-12h-9z"/>'),
  success: icons.check,
  question: svg('<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>'),
  failure: icons.close,
  bug: svg('<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M19 7l-3 2M5 7l3 2M19 19l-3-2M5 19l3-2M20 13h-4M4 13h4M10 4l1 2M14 4l-1 2"/>'),
  example: icons.ul,
  quote: icons.quote,
  abstract: icons.props,
  todo: icons.task,
}

const CALLOUT_ALIAS: Record<string, string> = {
  summary: 'abstract', tldr: 'abstract', hint: 'tip', check: 'success', done: 'success',
  help: 'question', faq: 'question', attention: 'warning', fail: 'failure', missing: 'failure',
  error: 'danger', cite: 'quote',
}

export function calloutKind(kind: string): string {
  const k = (kind || 'note').toLowerCase()
  return CALLOUT_ALIAS[k] || (calloutIcons[k] ? k : 'note')
}

export const CALLOUT_LABEL: Record<string, string> = {
  note: '注意', info: '信息', tip: '提示', important: '重要', warning: '警告', caution: '小心', danger: '危险',
  success: '成功', question: '问题', failure: '失败', bug: 'Bug', example: '示例', quote: '引用', abstract: '摘要', todo: '待办',
}
