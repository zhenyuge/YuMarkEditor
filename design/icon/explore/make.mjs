// Icon variants for YuMarkEditor. node design/icon/make.mjs -> design/icon/explore/variant-*.svg
import fs from 'node:fs'

// macOS icon grid: 824×824 continuous-corner squircle centred in 1024
function squircle(cx = 512, cy = 512, r = 412, n = 4.2, steps = 480) {
  const pts = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const c = Math.cos(t), s = Math.sin(t)
    pts.push([cx + r * Math.sign(c) * Math.abs(c) ** (2 / n), cy + r * Math.sign(s) * Math.abs(s) ** (2 / n)])
  }
  return 'M' + pts.map(p => p.map(v => v.toFixed(2)).join(' ')).join('L') + 'Z'
}
const SQ = squircle()

const defs = (bgA, bgB, extra = '') => `
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bgA}"/><stop offset="1" stop-color="${bgB}"/></linearGradient>
  <linearGradient id="gold" gradientUnits="userSpaceOnUse" x1="0" y1="380" x2="0" y2="660"><stop offset="0" stop-color="#F0C46A"/><stop offset="1" stop-color="#D49A35"/></linearGradient>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#000" flood-opacity=".28"/></filter>
  <clipPath id="clip"><path d="${SQ}"/></clipPath>
  ${extra}
</defs>`

const base = (bg, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
${bg}
<g filter="url(#shadow)"><path d="${SQ}" fill="url(#bg)"/></g>
<g clip-path="url(#clip)">
  <path d="M100 100H924V300H100Z" fill="#fff" opacity=".045"/>
  ${inner}
</g>
<path d="${SQ}" fill="none" stroke="#000" stroke-opacity=".12" stroke-width="2"/>
</svg>`

// ------------------------------------------------------------------ A: [Yu ↓] Markdown mark with Yu
const frame = (color, w = 36) => `<rect x="214" y="336" width="596" height="352" rx="66" fill="none" stroke="${color}" stroke-width="${w}"/>`
const yuStrokes = (color, W = 50) => `
  <g fill="none" stroke="${color}" stroke-width="${W}" stroke-linecap="butt" stroke-linejoin="miter">
    <path d="M292 424 L360 520 L428 424"/>
    <path d="M360 518 V604"/>
    <path d="M484 470 V548 A52 52 0 0 0 588 548 V470"/>
    <path d="M588 540 V604"/>
  </g>`
const arrow = (fill, x = 709, top = 424, tip = 606, shaft = 50, head = 112, headH = 70) =>
  `<path d="M${x - shaft / 2} ${top} H${x + shaft / 2} V${tip - headH} H${x + head / 2} L${x} ${tip} L${x - head / 2} ${tip - headH} H${x - shaft / 2} Z" fill="${fill}"/>`

const A = base(defs('#1F3B63', '#0D1D35'), frame('#FFFFFF') + yuStrokes('#FFFFFF') + arrow('url(#gold)'))

// ------------------------------------------------------------------ B: u whose right stem is the arrow
const B = base(defs('#1F3B63', '#0D1D35'), `
  ${frame('#FFFFFF')}
  <g fill="none" stroke="#FFFFFF" stroke-width="54" stroke-linejoin="miter">
    <path d="M318 424 L396 530 L474 424"/>
    <path d="M396 528 V604"/>
    <path d="M540 470 V548 A56 56 0 0 0 652 548"/>
  </g>
  ${arrow('url(#gold)', 652, 424, 616, 54, 118, 72)}`)

// ------------------------------------------------------------------ C: light paper version of A
const C = base(defs('#FFFFFF', '#E9EDF3'), frame('#1C355A') + yuStrokes('#1C355A') + arrow('url(#gold)'))

// ------------------------------------------------------------------ D: bold wordmark, no frame, arrow under
const D = base(defs('#1F3B63', '#0D1D35'), `
  <g fill="none" stroke="#FFFFFF" stroke-width="70" stroke-linejoin="miter">
    <path d="M262 318 L380 470 L498 318"/>
    <path d="M380 466 V620"/>
    <path d="M570 400 V540 A80 80 0 0 0 730 540 V400"/>
    <path d="M730 530 V620"/>
  </g>
  <rect x="262" y="690" width="340" height="30" rx="15" fill="#FFFFFF" opacity=".35"/>
  <path d="M700 676 V716" stroke="url(#gold)" stroke-width="40"/>
  <path d="M662 706 H738 L700 758 Z" fill="url(#gold)"/>`)

for (const [k, v] of Object.entries({ A, B, C, D })) fs.writeFileSync(`design/icon/explore/variant-${k}.svg`, v)
console.log('ok')
