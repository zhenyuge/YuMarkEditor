const jd = window.__jd
const sleep = ms => new Promise(r => setTimeout(r, ms))
const call = (cmd, args) => webkit.messageHandlers.bridge.postMessage({ cmd, args })
const add = document.querySelector('.tab-add').getBoundingClientRect()
const tab = document.querySelector('.tab').getBoundingClientRect()
const pts = [[add.x + add.width / 2, add.y + add.height / 2], [tab.x + 20, tab.y + 10], [700, 15], [30, 15], [600, 300]]
const hits = await call('testHit', pts)
const before = jd.docs.length
await call('testClick', pts[0])
await sleep(400)
const after = jd.docs.length
return 'hits=' + JSON.stringify(hits) + '\nplus-click docs ' + before + ' -> ' + after + '\nregions=' + document.querySelectorAll('.tab, .tb-btn').length
