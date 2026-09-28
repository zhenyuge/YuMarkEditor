// Tiny static server for UI tests: serves dist/ and maps /@fs/<abs path> to the filesystem.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.md': 'text/markdown' }
export function serve(root, port) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const file = p.startsWith('/@fs/') ? p.slice(4) : path.join(root, p === '/' ? 'index.html' : p)
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
      res.end(data)
    })
  })
  return new Promise(r => server.listen(port, () => r(server)))
}
