// Build the web UI into dist/ (loaded by the native app from its Resources).
import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'

const dev = process.argv.includes('--dev')
const out = 'dist'
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

// the Word exporter may not exist in partial checkouts: stub it so the rest still builds
const stubDocx = {
  name: 'stub-docx',
  setup(b) {
    if (fs.existsSync('src/export/docx.ts')) return
    b.onResolve({ filter: /^\.\/docx$/ }, () => ({ path: 'docx-stub', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export async function markdownToDocx(){ throw new Error("Word export not built") }', loader: 'js' }))
  },
}

const result = await esbuild.build({
  plugins: [stubDocx],
  entryPoints: { app: 'src/main.ts' },
  bundle: true,
  format: 'esm',
  splitting: true,
  outdir: out,
  chunkNames: 'chunks/[name]-[hash]',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  target: ['safari16'],
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
})

// static files
for (const f of fs.readdirSync('static')) fs.copyFileSync(path.join('static', f), path.join(out, f))

// KaTeX: css + woff2 fonts only; plus a font-inlined css for exports
const kdir = 'node_modules/katex/dist'
fs.mkdirSync(`${out}/vendor/katex/fonts`, { recursive: true })
let kcss = fs.readFileSync(`${kdir}/katex.min.css`, 'utf8')
kcss = kcss.replace(/src:url\((fonts\/[^)]+\.woff2)\) format\("woff2"\)(,url\([^)]+\) format\("[^"]+"\))*/g, 'src:url($1) format("woff2")')
fs.writeFileSync(`${out}/vendor/katex/katex.min.css`, kcss)
for (const f of fs.readdirSync(`${kdir}/fonts`)) if (f.endsWith('.woff2')) fs.copyFileSync(`${kdir}/fonts/${f}`, `${out}/vendor/katex/fonts/${f}`)
const inline = kcss.replace(/url\((fonts\/[^)]+\.woff2)\)/g, (_, f) => `url(data:font/woff2;base64,${fs.readFileSync(`${kdir}/${f}`).toString('base64')})`)
fs.writeFileSync(`${out}/katex-inline.css`, inline)

// Mermaid: ESM build, loaded on demand
const mdir = 'node_modules/mermaid/dist'
fs.mkdirSync(`${out}/vendor/mermaid/chunks/mermaid.esm.min`, { recursive: true })
fs.copyFileSync(`${mdir}/mermaid.esm.min.mjs`, `${out}/vendor/mermaid/mermaid.esm.min.mjs`)
for (const f of fs.readdirSync(`${mdir}/chunks/mermaid.esm.min`)) {
  if (!f.endsWith('.map')) fs.copyFileSync(`${mdir}/chunks/mermaid.esm.min/${f}`, `${out}/vendor/mermaid/chunks/mermaid.esm.min/${f}`)
}

const size = p => fs.statSync(p).size
let total = 0
const walk = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : (total += size(p)) } }
walk(out)
const appSize = size(`${out}/app.js`)
console.log(`web build ok: app.js ${(appSize / 1024).toFixed(0)} KB, dist total ${(total / 1024 / 1024).toFixed(1)} MB`)
if (process.argv.includes('--meta')) fs.writeFileSync('meta.json', JSON.stringify(result.metafile))
