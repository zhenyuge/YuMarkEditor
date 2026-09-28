const call = (cmd, args) => webkit.messageHandlers.bridge.postMessage({ cmd, args })
// scripts/apptest.sh runs the app with YUMARK_SUPPORT=<repo>/build/test-support
const dir = window.__jd.appSupport.replace(/test-support\/?$/, 'fixtures/ops')
const out = []
const safe = async (name, fn) => { try { out.push(name + ': ' + JSON.stringify(await fn())) } catch (e) { out.push(name + ' ERR: ' + e) } }
await safe('createFile', () => call('createFile', [dir + '/笔记.md', '# hi\n']))
await safe('createFile again', () => call('createFile', [dir + '/笔记.md', '']))
await safe('duplicate', () => call('duplicate', dir + '/笔记.md'))
await safe('duplicate2', () => call('duplicate', dir + '/笔记.md'))
await safe('rename', () => call('rename', [dir + '/笔记 副本.md', '改名.md']))
await safe('createDir', () => call('createDir', dir + '/子目录'))
await safe('list', async () => (await call('listDir', dir)).map(e => e.name + (e.dir ? '/' : '')).sort())
await safe('trash', () => call('trash', dir + '/笔记 副本 2.md'))
await safe('stat', () => call('stat', [dir + '/笔记.md', dir + '/nope.md']).then(r => r.map(x => x.exists)))
// a 1200x800 PNG made on a canvas -> WebP in assets/
const c = document.createElement('canvas'); c.width = 1200; c.height = 800
const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 1200, 800); gr.addColorStop(0, '#36d'); gr.addColorStop(1, '#f96'); g.fillStyle = gr; g.fillRect(0, 0, 1200, 800)
g.fillStyle = '#fff'; g.font = '120px sans-serif'; g.fillText('粘贴的截图', 200, 450)
const blob = await new Promise(r => c.toBlob(r, 'image/png'))
const buf = new Uint8Array(await blob.arrayBuffer())
let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
out.push('png bytes: ' + buf.length)
await safe('saveImage', () => call('saveImage', { dir, base64: btoa(s), mime: 'image/png', name: 'x.png' }))
return out.join('\n')
