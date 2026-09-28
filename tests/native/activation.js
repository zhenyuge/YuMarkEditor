const sleep = ms => new Promise(r => setTimeout(r, ms))
const call = (cmd, args) => webkit.messageHandlers.bridge.postMessage({ cmd, args })
await sleep(300) // let the title bar report its button rects
const btn = document.querySelector('.sidebar-toggle')
const r = btn.getBoundingClientRect()
const x = r.x + r.width / 2, y = r.y + r.height / 2
let clicks = 0
btn.addEventListener('click', () => clicks++)
const shown = () => document.body.classList.contains('show-sidebar')
const out = [`sidebar button now at x ${r.left}..${r.right}`]
let before = shown(), c0 = clicks
await call('testActivationClick', [x, y, false])
out.push(`swallowed activation click -> replayed: toggled=${shown() !== before} clicks=${clicks - c0}`)
before = shown(); c0 = clicks
await call('testActivationClick', [x, y, true])
await sleep(200)
out.push(`delivered activation click -> no replay: toggled=${shown() !== before} clicks=${clicks - c0}`)
// a press on an empty part of the title bar must never be replayed
const tabs = document.querySelector('.drag-fill').getBoundingClientRect()
before = shown(); const n0 = window.__jd.docs.length
await call('testActivationClick', [tabs.x + tabs.width / 2, 18, false])
out.push(`press on empty title bar -> nothing: sidebar unchanged=${shown() === before} docs unchanged=${window.__jd.docs.length === n0}`)
return out.join('\n')
