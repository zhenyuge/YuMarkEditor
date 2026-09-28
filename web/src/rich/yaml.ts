// Just enough YAML to display a frontmatter card: `key: value`, `key: [a, b]`
// and block lists. Returns null when the text looks like something else, in
// which case the raw text is shown instead.
export function parseYamlLite(text: string): [string, string | string[]][] | null {
  const out: [string, string | string[]][] = []
  const lines = text.split(/\r?\n/)
  const unquote = (s: string) => {
    s = s.trim()
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
    return s
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const m = /^([^\s:#][^:]*?):(?:\s+(.*))?\s*$/.exec(line)
    if (!m) {
      if (/^\s/.test(line) && out.length) continue // nested content we don't render
      return null
    }
    const key = m[1].trim()
    let val = (m[2] || '').trim()
    if (val.startsWith('[') && val.endsWith(']')) {
      out.push([key, val.slice(1, -1).split(',').map(unquote).filter(Boolean)])
    } else if (!val) {
      const items: string[] = []
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(unquote(lines[++i].replace(/^\s*-\s+/, '')))
      if (items.length) out.push([key, items])
      else {
        const nested: string[] = []
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) nested.push(lines[++i].trim())
        out.push([key, nested.join('; ')])
      }
    } else if (val === '|' || val === '>' || val === '|-' || val === '>-') {
      const body: string[] = []
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || !lines[i + 1].trim())) body.push(lines[++i].trim())
      out.push([key, body.join(val.startsWith('>') ? ' ' : '\n').trim()])
    } else {
      if (val.startsWith('#')) val = ''
      out.push([key, unquote(val.replace(/\s+#.*$/, ''))])
    }
  }
  return out
}
