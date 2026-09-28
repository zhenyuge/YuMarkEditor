import puppeteer from 'puppeteer-core'
import { serve } from './server.mjs'
import fs from 'node:fs'
const OUT = 'test/.out'
fs.mkdirSync(OUT, { recursive: true })
const server = await serve('dist', 8765)
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--no-sandbox', '--force-device-scale-factor=2'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1100, height: 760, deviceScaleFactor: 2 })
const logs = []
page.on('console', m => logs.push(m.type() + ': ' + m.text()))
page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message))
const sample = fs.readFileSync('test/sample.md', 'utf8')
await page.evaluateOnNewDocument((sample) => {
  window.__MOCK_FILES__ = { '/mock/docs/示例.md': sample, '/mock/docs/other.md': '# Other\n\ntext\n', '/mock/docs/sub/a.md': 'a\n' }
  window.__MOCK_OPEN__ = [{ path: '/mock/docs/示例.md', dir: false }]
  window.__MOCK_SESSION__ = { version: 1, tabs: [], folder: '/mock/docs', sidebar: true }
}, sample)
await page.goto('http://localhost:8765/index.html')
await page.waitForSelector('body.ready', { timeout: 10000 })
await new Promise(r => setTimeout(r, 1500))
await page.screenshot({ path: `${OUT}/ui-rich.png` })
const scenario = process.argv[2]
if (scenario) {
  const mod = await import('./' + scenario)
  await mod.default(page, { OUT, logs })
}
console.log(logs.filter(l => !l.includes('Download the React')).slice(0, 40).join('\n'))
await browser.close()
server.close()
