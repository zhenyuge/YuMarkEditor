const sleep = ms => new Promise(r => setTimeout(r, ms))
export default async function (page, { OUT }) {
  const key = async (combo) => {
    const parts = combo.split('+'); const k = parts.pop()
    for (const m of parts) await page.keyboard.down(m)
    await page.keyboard.press(k)
    for (const m of parts.reverse()) await page.keyboard.up(m)
    await sleep(100)
  }
  const results = []
  const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)
  const md = () => page.evaluate(() => window.__jd.active.text())
  await key('Meta+n')
  // inline math via input rule
  await page.keyboard.type('Energy $E=mc^2$ ok')
  await sleep(200)
  check('inline math rule', (await md()) === 'Energy $E=mc^2$ ok\n', JSON.stringify(await md()))
  check('katex rendered', await page.$eval('.math-inline', el => !!el.querySelector('.katex')))
  // click math -> popover, edit tex
  await page.click('.math-inline')
  await sleep(200)
  const popVisible = await page.$eval('.popover', el => el.style.display !== 'none')
  check('math popover opens', popVisible)
  await page.keyboard.press('End')
  await page.keyboard.type('+1')
  await key('Enter')
  await sleep(150)
  check('math edited', (await md()) === 'Energy $E=mc^2+1$ ok\n', JSON.stringify(await md()))
  // new paragraph, callout via slash
  await key('End'); await key('Enter')
  await page.keyboard.type('/callout')
  await key('Enter')
  await page.keyboard.type('Be careful')
  await sleep(100)
  check('callout inserted', (await md()).includes('> [!NOTE]\n> Be careful'), JSON.stringify(await md()))
  // exit callout: Enter twice then Backspace lifts? use Mod-Enter
  await key('Meta+Enter')
  await page.keyboard.type('- [ ] task one')
  await sleep(100)
  check('task input rule', (await md()).includes('- [ ] task one'), JSON.stringify(await md()))
  // toggle checkbox by click
  await page.click('li.task-item input[type=checkbox]')
  await sleep(100)
  check('checkbox toggles', (await md()).includes('- [x] task one'))
  // move block up (Alt+ArrowUp) — task list moves above callout
  await key('Alt+ArrowUp')
  await sleep(100)
  const t = await md()
  check('move block up', t.indexOf('- [x] task one') < t.indexOf('> [!NOTE]'), JSON.stringify(t))
  // code block via ```
  await key('Meta+Enter')
  await page.keyboard.type('```py ')
  await page.keyboard.type('def f(x):')
  await key('Enter')
  await page.keyboard.type('return x')
  await sleep(600)
  check('code block', (await md()).includes('```py\ndef f(x):\nreturn x\n```'), JSON.stringify(await md()))
  check('highlighted', await page.$eval('.code-block', el => !!el.querySelector('.hljs-keyword')))
  // undo

  // replace all
  await key('Meta+Alt+f')
  await page.keyboard.type('task')
  await page.click('.fb-replace .fb-input')
  await page.keyboard.type('TODO')
  await page.click('.fb-replace .fb-text-btn:last-child')
  await sleep(200)
  check('replace all', (await md()).includes('TODO one') && !(await md()).includes('task one'), JSON.stringify(await md()))
  await key('Escape')
  // source mode formatting: select word and bold
  await key('Meta+e'); await sleep(900)
  await page.evaluate(() => { const s = window.__jd.source; const i = s.text().indexOf('Energy'); s.view.dispatch({ selection: { anchor: i, head: i + 6 } }) })
  await key('Meta+b')
  await sleep(100)
  check('source bold', (await md()).startsWith('**Energy**'), JSON.stringify((await md()).slice(0, 30)))
  await key('Meta+e'); await sleep(300)
  check('rich shows bold', await page.$eval('.ProseMirror p strong', el => el.textContent === 'Energy'))
  // dark mode screenshot of the sample doc
  await page.evaluate(() => window.__jd.dispatch('selectTab', 1))
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
  await sleep(1200)
  await page.screenshot({ path: `${OUT}/ui-dark.png` })
  await page.evaluate(() => { document.querySelector('.rich-scroller').scrollTop = 1500 })
  await sleep(1200)
  await page.screenshot({ path: `${OUT}/ui-dark2.png` })
  console.log(results.join('\n'))
}
