// Serves the lineup and guide on your home network so the TV can read them.
//
//   node tools/serve-guide.mjs [--port 8787] [--dir guide]
//
// The TV app reads http://<this PC>:8787/lineup.json and
// http://<this PC>:8787/guide-window.json. The window is cut fresh on every request:
// programmes from an hour ago to 15 hours ahead, small enough for an older TV.
// guide.json?hours=N gives a different window length. Node 18+ only, no packages.

import { createServer } from 'node:http'
import { createReadStream, statSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join, resolve, normalize } from 'node:path'
import { guideWindow } from './window.mjs'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : def
}
const PORT = Number(opt('--port', 8787))
const DIR = resolve(opt('--dir', 'guide'))
const TYPES = { '.xml': 'application/xml; charset=utf-8', '.gz': 'application/gzip', '.json': 'application/json; charset=utf-8' }

// guide.json is reread whenever the builder rewrites it.
let guide = { mtime: 0, data: null }
function loadGuide() {
  const file = join(DIR, 'guide.json')
  const m = statSync(file).mtimeMs
  if (m !== guide.mtime) guide = { mtime: m, data: JSON.parse(readFileSync(file, 'utf8')) }
  return guide.data
}


createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-cache')

  const windowed = path === 'guide-window.json' || (path === 'guide.json' && url.searchParams.has('hours'))
  if (windowed) {
    try {
      const hours = path === 'guide-window.json' ? 15 : Math.min(48, Math.max(1, Number(url.searchParams.get('hours')) || 12))
      const body = guideWindow(loadGuide().channels, hours)
      res.writeHead(200, { 'Content-Type': TYPES['.json'] })
      return res.end(body)
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      return res.end('Guide not built yet: ' + e.message)
    }
  }

  const file = join(DIR, path)
  let st
  try { st = statSync(file) } catch { st = null }
  if (!file.startsWith(DIR) || !st || !st.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    return res.end('Not found')
  }
  res.writeHead(200, { 'Content-Type': TYPES[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream', 'Content-Length': st.size })
  createReadStream(file).pipe(res)
}).listen(PORT, () => {
  const ips = Object.values(networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address)
  console.log(`Serving ${DIR}`)
  for (const ip of ips) console.log(`  http://${ip}:${PORT}/lineup.json`)
  console.log('Leave this window open while you use the TV app. Ctrl+C stops it.')
})
