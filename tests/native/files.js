const jd = window.__jd
const sleep = ms => new Promise(r => setTimeout(r, ms))
for (let i = 0; i < 40 && jd.docs.filter(d => d.path).length < 2; i++) await sleep(100)
const out = []
for (const d of jd.docs.filter(d => d.path)) {
  await jd.dispatch('selectTab', jd.docs.indexOf(d) + 1)
  await sleep(200)
  const view = jd.rich.view
  let pos = -1
  view.state.doc.forEach((n, off) => { if (pos < 0 && n.textContent === '改这一段。') pos = off + 1 })
  view.dispatch(view.state.tr.insertText('已', pos + '改这一段'.length))
  await sleep(50)
  await jd.dispatch('save')
  await sleep(300)
  out.push(d.title + ' saved dirty=' + d.dirty + ' bom=' + d.bom)
}
return out.join('\n')
