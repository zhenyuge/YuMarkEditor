const jd = window.__jd
const sleep = ms => new Promise(r => setTimeout(r, ms))
const call = (cmd, args) => webkit.messageHandlers.bridge.postMessage({ cmd, args })
const btn = document.querySelector('.sidebar-toggle')
const r = btn.getBoundingClientRect()
const cx = r.x + r.width / 2, cy = r.y + r.height / 2
let downs = 0, clicks = 0
btn.addEventListener('mousedown', () => downs++)
btn.addEventListener('click', () => clicks++)
const shown = () => document.body.classList.contains('show-sidebar')
const out = []
const trial = async (label, opts) => {
  const before = shown(), d0 = downs, c0 = clicks
  await call('testClick', [cx, cy, opts])
  await sleep(250)
  out.push(`${label}: toggled=${shown() !== before} mousedown+${downs - d0} click+${clicks - c0}`)
}
for (let i = 1; i <= 4; i++) await trial(`active #${i}`, {})
await trial('double-click (count=2)', { count: 2 })
for (let i = 1; i <= 3; i++) { await trial(`inactive #${i}`, { inactive: true }); await sleep(200) }
return out.join('\n')
