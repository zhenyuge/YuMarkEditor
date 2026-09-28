// Renders design/icon/*.svg to PNG with headless Chrome (transparent background).
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
const require = createRequire(new URL('../../web/package.json', import.meta.url))
const puppeteer = require('puppeteer-core')
const [,, svgPath, outPath, size = '1024'] = process.argv
const svg = fs.readFileSync(svgPath, 'utf8')
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
const s = +size
await page.setViewport({ width: s, height: s, deviceScaleFactor: 1 })
await page.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${s}px;height:${s}px">${svg.replace('<svg ', `<svg width="${s}" height="${s}" `)}</div></body></html>`)
await page.screenshot({ path: outPath, omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } })
await browser.close()
