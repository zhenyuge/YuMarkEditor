const jd = window.__jd
const sleep = ms => new Promise(r => setTimeout(r, ms))
for (let i = 0; i < 40 && !jd.docs.some(d => d.path); i++) await sleep(100)
const dir = jd.active.path.replace(/\/[^/]+$/, '')
const out = []
for (let i = 1; i <= 5; i++) {
  try { await jd.exportAs('pdf', `${dir}/export/run-${i}.pdf`); out.push(`pdf #${i} ok`) } catch (e) { out.push(`pdf #${i} FAIL ${e}`) }
}
try { await jd.exportAs('png', dir + '/export/run.png'); out.push('png ok') } catch (e) { out.push('png FAIL ' + e) }
try { await jd.exportAs('docx', dir + '/export/run.docx'); out.push('docx ok') } catch (e) { out.push('docx FAIL ' + e) }
await sleep(500)
return out.join('\n')
