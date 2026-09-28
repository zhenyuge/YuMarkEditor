const sleep = ms => new Promise(r => setTimeout(r, ms))
export default async function (page, { OUT }) {
  const results = []
  const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)
  const md = () => page.evaluate(() => window.__jd.active.text())
  await page.keyboard.down('Meta'); await page.keyboard.press('n'); await page.keyboard.up('Meta')
  await sleep(200)
  const paste = (data) => page.evaluate(async (data) => {
    const dt = new DataTransfer()
    for (const [type, value] of Object.entries(data)) {
      if (type === 'file') {
        const c = document.createElement('canvas'); c.width = 40; c.height = 30
        const blob = await new Promise(r => c.toBlob(r, 'image/png'))
        dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
      } else dt.setData(type, value)
    }
    document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, data)
  await paste({ 'text/plain': '# 粘贴的标题\n\n- a\n- **b**\n\n| x | y |\n|---|---|\n| 1 | 2 |\n' })
  await sleep(200)
  check('paste markdown -> rich', await page.evaluate(() => !!document.querySelector('.ProseMirror h1') && !!document.querySelector('.ProseMirror table')), JSON.stringify(await md()))
  await paste({ 'text/html': '<p>来自<b>网页</b>的 <a href="https://x.com">链接</a></p>', 'text/plain': '来自网页的 链接' })
  await sleep(200)
  check('paste html', (await md()).includes('来自**网页**的 [链接](https://x.com)'), JSON.stringify(await md()))
  await paste({ file: 1 })
  await sleep(400)
  const log = await page.evaluate(() => window.__MOCK_LOG__.filter(e => e.cmd === 'saveImage').length)
  check('paste image -> saveImage', log === 1 && (await md()).includes('![](/mock/support/untitled/'), JSON.stringify(await md()))
  // copy as markdown
  const copied = await page.evaluate(() => {
    const v = window.__jd.rich.view
    const slice = v.state.doc.slice(0, v.state.doc.content.size)
    return v.someProp('clipboardTextSerializer', f => f(slice, v))
  })
  check('copy is markdown', copied.startsWith('# 粘贴的标题\n\n- a\n- **b**'), JSON.stringify(copied.slice(0, 60)))
  // plain text that is not markdown stays inline
  await paste({ 'text/plain': 'just words' })
  await sleep(100)
  check('plain paste', (await md()).includes('just words'))
  console.log(results.join('\n'))
}
