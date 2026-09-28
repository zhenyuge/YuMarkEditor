const sleep = ms => new Promise(r => setTimeout(r, ms))
const call = (cmd, args) => webkit.messageHandlers.bridge.postMessage({ cmd, args })
const btn = document.querySelector('.sidebar-toggle')
const r = btn.getBoundingClientRect()
let downs = 0, clicks = 0, ups = 0
btn.addEventListener('mousedown', () => downs++)
btn.addEventListener('mouseup', () => ups++)
btn.addEventListener('click', () => clicks++)
const shown = () => document.body.classList.contains('show-sidebar')
const out = []
for (let i = 1; i <= 3; i++) {
  const before = shown(), d0 = downs, u0 = ups, c0 = clicks
  await call('testClick', [r.x + r.width / 2, r.y + r.height / 2, { inactive: true }])
  await sleep(400)
  out.push(`from background #${i}: toggled=${shown() !== before} mousedown+${downs - d0} mouseup+${ups - u0} click+${clicks - c0}`)
}
return out.join('\n')
