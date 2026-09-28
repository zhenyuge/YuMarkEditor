const jd = window.__jd
const sleep = ms => new Promise(r => setTimeout(r, ms))
for (let i = 0; i < 40 && !jd.docs.some(d => d.path); i++) await sleep(100)
const dir = jd.active.path.replace(/\/[^/]+$/, '')
const t0 = performance.now()
try { await jd.exportAs('docx', dir + '/export/out.docx') } catch (e) { return 'FAIL ' + e }
return 'docx ok ' + Math.round(performance.now() - t0) + 'ms'
