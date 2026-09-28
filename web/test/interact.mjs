const sleep = ms => new Promise(r => setTimeout(r, ms))
export default async function (page, { OUT }) {
  const key = async (combo) => {
    const parts = combo.split('+'); const k = parts.pop()
    for (const m of parts) await page.keyboard.down(m)
    await page.keyboard.press(k)
    for (const m of parts.reverse()) await page.keyboard.up(m)
    await sleep(120)
  }
  const log = () => page.evaluate(() => window.__MOCK_LOG__)
  const results = []
  const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)

  // --- 1. byte-preserving edit of the sample document
  const sampleText = await page.evaluate(() => window.__MOCK_FILES__['/mock/docs/示例.md'])
  await page.evaluate(() => {
    const p = [...document.querySelectorAll('.ProseMirror p')].find(p => p.textContent.startsWith('这是一段'))
    const r = document.createRange(); r.setStart(p.firstChild, 0); r.collapse(true)
    const s = getSelection(); s.removeAllRanges(); s.addRange(r)
  })
  await page.focus('.ProseMirror')
  await page.keyboard.type('X')
  await key('Meta+s')
  await sleep(300)
  let l = await log()
  let w = l.filter(e => e.cmd === 'writeFile').pop()
  const expected = sampleText.replace('这是一段', 'X这是一段')
  check('edit keeps other bytes', w && w.args.text === expected, w ? '' : '(no write)')
  if (w && w.args.text !== expected) {
    const a = w.args.text, b = expected
    let i = 0; while (a[i] === b[i]) i++
    results.push('  diff at ' + i + ': got ' + JSON.stringify(a.slice(i - 20, i + 60)) + '\n  want ' + JSON.stringify(b.slice(i - 20, i + 60)))
  }
  const tabDirty = await page.$eval('.tab.active', el => el.classList.contains('dirty'))
  check('clean after save', !tabDirty)

  // --- 2. new doc + typing with input rules
  await key('Meta+n')
  await sleep(200)
  await page.keyboard.type('# Hello')
  await key('Enter')
  await page.keyboard.type('Some **bold** and *em* text with my_var ')
  await key('Enter')
  await page.keyboard.type('- first')
  await key('Enter')
  await page.keyboard.type('second')
  await key('Enter')
  await key('Enter')
  await page.keyboard.type('/tab')
  await sleep(200)
  const slashVisible = await page.$eval('.slash-menu', el => el.style.display !== 'none' && el.textContent)
  check('slash menu shows table', !!slashVisible && slashVisible.includes('表格'), JSON.stringify(slashVisible))
  await page.screenshot({ path: `${OUT}/ui-slash.png` })
  await key('Enter')
  await page.keyboard.type('A')
  await key('Tab')
  await page.keyboard.type('B')
  await sleep(100)
  // select "bold" word to show bubble
  await page.evaluate(() => {
    const s = document.querySelector('.ProseMirror strong')
    const r = document.createRange(); r.selectNodeContents(s)
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r)
  })
  await page.mouse.move(10, 10); await page.mouse.down(); await page.mouse.up()
  await page.evaluate(() => document.querySelector('.ProseMirror').focus())
  await page.evaluate(() => {
    const s = document.querySelector('.ProseMirror strong')
    const r = document.createRange(); r.selectNodeContents(s)
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r)
  })
  await sleep(300)
  await page.screenshot({ path: `${OUT}/ui-bubble.png` })
  const bubble = await page.$eval('.bubble', el => el.style.display !== 'none')
  check('bubble on selection', bubble)

  await page.evaluate(() => { window.__MOCK_SAVE_PATH__ = '/mock/docs/new.md' })
  await key('Meta+s')
  await sleep(400)
  l = await log()
  w = l.filter(e => e.cmd === 'writeFile').pop()
  const want = '# Hello\n\nSome **bold** and *em* text with my_var\n\n- first\n- second\n\n| A   | B   |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n'
  check('new doc markdown', w && w.args.path === '/mock/docs/new.md' && w.args.text === want, w ? JSON.stringify(w.args.text) : '')
  const title = await page.$eval('.tab.active .tab-title', el => el.textContent)
  check('tab renamed after save', title === 'new', title)

  // --- 3. source mode round trip
  await key('Meta+e')
  await sleep(1200)
  const cm = await page.evaluate(() => window.__jd.source?.text())
  check('source mode shows markdown', cm === want, JSON.stringify(cm))
  await page.screenshot({ path: `${OUT}/ui-source.png` })
  await key('Meta+e')
  await sleep(300)
  const mode = await page.evaluate(() => window.__jd.active.mode)
  check('back to rich', mode === 'rich')

  // --- 4. find
  await key('Meta+f')
  await page.keyboard.type('i')
  await sleep(300)
  const count = await page.$eval('.fb-count', el => el.textContent)
  check('find count', /\d+\/\d+/.test(count), count)
  await page.screenshot({ path: `${OUT}/ui-find.png` })
  await key('Escape')

  // --- 5. tabs: reopen closed
  const nTabs = await page.$$eval('.tab', t => t.length)
  await key('Meta+w')
  await sleep(200)
  const nTabs2 = await page.$$eval('.tab', t => t.length)
  await key('Meta+Shift+t')
  await sleep(400)
  const nTabs3 = await page.$$eval('.tab', t => t.length)
  check('close + reopen tab', nTabs2 === nTabs - 1 && nTabs3 === nTabs, `${nTabs} ${nTabs2} ${nTabs3}`)

  // --- 6. session json contains unsaved untitled content
  await key('Meta+n')
  await page.keyboard.type('unsaved note')
  await sleep(1300)
  const session = await page.evaluate(() => JSON.parse(window.__SESSION__ || '{}'))
  check('session keeps unsaved text', session.tabs?.some(t => !t.path && t.text === 'unsaved note\n'), JSON.stringify(session.tabs?.map(t => t.text)))
  await page.screenshot({ path: `${OUT}/ui-final.png` })
  console.log(results.join('\n'))
}
