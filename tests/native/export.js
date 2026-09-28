const jd = window.__jd
const sleep = ms => new Promise(r => setTimeout(r, ms))
for (let i = 0; i < 40 && !jd.docs.some(d => d.path); i++) await sleep(100)
const dir = jd.active.path.replace(/\/[^/]+$/, '')
const out = []; window.__jdDebug = true; webkit.messageHandlers.bridge.postMessage({cmd:"log", args:"test start"})
for (const [kind, name] of [['pdf', 'out.pdf'], ['png', 'out.png'], ['html', 'out.html']]) {
  const t0 = performance.now()
  try { await jd.exportAs(kind, dir + '/export/' + name); out.push(kind + ' ok ' + Math.round(performance.now() - t0) + 'ms') }
  catch (e) { out.push(kind + ' FAIL ' + e) }
}
await sleep(300)
return out.join('\n')
