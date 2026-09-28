const call = (cmd, args) => webkit.messageHandlers.bridge.postMessage({ cmd, args })
const out = []
const btn = document.querySelector('.sidebar-toggle').getBoundingClientRect()
out.push(`sidebar button: x ${btn.left}..${btn.right}, y ${btn.top}..${btn.bottom}`)
const pts = []
for (let y = 2; y <= 36; y += 4) for (let x = 60; x <= 114; x += 3) pts.push([x, y])
const hits = await call('testHit', pts)
hits.shift() // drag rects
// map: . = web view, # = something else
let row = '', lastY = pts[0][1]
const rows = []
pts.forEach((p, i) => {
  if (p[1] !== lastY) { rows.push(`y=${String(lastY).padStart(2)} ${row}`); row = ''; lastY = p[1] }
  row += hits[i] === 'EditorWebView' ? '.' : hits[i][0] === 'N' ? '#' : '?'
})
rows.push(`y=${String(lastY).padStart(2)} ${row}`)
out.push('x from 60 to 114 step 3 (. = web view, # = native titlebar view)')
out.push(...rows)
out.push('non-web classes: ' + [...new Set(hits.filter(h => h !== 'EditorWebView'))].join(', '))
return out.join('\n')
