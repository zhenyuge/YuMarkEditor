const jd = window.__jd
const out = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
out.push('docs=' + jd.docs.length + ' mode=' + jd.active.mode + ' title=' + jd.active.title)
jd.rich.view.dispatch(jd.rich.view.state.tr.insertText('Hello from the native test'))
await sleep(400)
out.push('text=' + JSON.stringify(jd.active.text()))
out.push('dirty=' + jd.active.dirty)
// katex + highlight + mermaid lazy loading via custom scheme
const k = await import('./chunks/' + [...document.scripts].length) .catch(e => 'n/a')
const mm = await (await import(new URL('vendor/mermaid/mermaid.esm.min.mjs', document.baseURI).href)).default
out.push('mermaid=' + typeof mm.render)
const res = await fetch('content.css'); out.push('css=' + res.status)
return out.join('\n')
