const jd = window.__jd
const sleep = ms => new Promise(r => setTimeout(r, ms))
for (let i = 0; i < 40 && !jd.docs.some(d => d.path); i++) await sleep(100)
const dir = jd.active.path.replace(/\/[^/]+$/, '')
const t0 = performance.now()
await jd.exportAs('png', dir + '/export/long.png')
return 'png ' + Math.round(performance.now() - t0) + 'ms'
