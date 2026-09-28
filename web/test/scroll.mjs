export default async function (page, { OUT }) {
  for (let i = 1; i <= 4; i++) {
    await page.evaluate(i => { document.querySelector('.rich-scroller').scrollTop = i * 640 }, i)
    await new Promise(r => setTimeout(r, 700))
    await page.screenshot({ path: `${OUT}/ui-scroll${i}.png` })
  }
}
