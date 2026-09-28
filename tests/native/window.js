const jd = window.__jd
const sleep = ms => new Promise(r => setTimeout(r, ms))
for (let i = 0; i < 40 && !jd.docs.some(d => d.path); i++) await sleep(100)
jd.dispatch('new'); await sleep(200)
jd.dispatch('selectTab', 1); await sleep(300)
jd.dispatch('toggleSidebar'); await sleep(500)
return 'ok'
