// Builds the US-only channel lineup and its programme guide for the TV app.
//
//   node tools/build-lineup.mjs [--days 2] [--no-check] [--out guide]
//
// Writes guide/lineup.json (channels and folders) and guide/guide.json (listings).
//
// Channels: every iptv-org channel whose country is US and whose feed is broadcast
// in the US, minus closed, adult, blocklisted and header-locked streams. Each stream
// is test-opened; channels with no working stream are left out (skip with --no-check).
//
// Guide, in order of preference:
//   1. iptv-org's guide index, for sources readable without their grabber
//      (i.mjh.nz XMLTV files and tvpassport.com station pages);
//   2. Pluto TV channels matched by the id in their stream address;
//   3. local stations matched to tvpassport.com by call sign;
//   4. network affiliates with no schedule of their own get the same network's
//      schedule from another station in their time zone, labelled as such;
//   5. anything left gets a one-line description of what it carries.
// Node 18+ only, no packages.

import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { classify, describe, cityNews, NATIONAL_NEWS_ORDER, NEWS_ORDER, SPORTS_ORDER, TOP_ORDER } from './classify.mjs'
import { guideWindow } from './window.mjs'

const args = process.argv.slice(2)
const flag = name => { const i = args.indexOf(name); return i >= 0 ? (args.splice(i, 1), true) : false }
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : def }
const DAYS = Number(opt('--days', 2))
const OUT = resolve(opt('--out', 'guide'))
const CHECK = !flag('--no-check')
const CACHE = join(OUT, 'cache')

const API = 'https://iptv-org.github.io/api/'
const MJH = 'https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master'
const TVP_LIST = 'https://raw.githubusercontent.com/iptv-org/epg/master/sites/tvpassport.com/tvpassport.com.channels.xml'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

const log = (...a) => console.log(...a)

async function text(url, { timeout = 60000, headers = {} } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(timeout) })
  if (!res.ok) throw new Error(`${res.status} for ${url}`)
  return res.text()
}
const json = async url => JSON.parse(await text(url))

// Cached fetch for guide pages, so a rebuild within a few hours is quick and polite.
async function cached(key, maxAgeMs, load) {
  const file = join(CACHE, key.replace(/[^a-z0-9.-]+/gi, '_'))
  try {
    const { t, body } = JSON.parse(await readFile(file, 'utf8'))
    if (Date.now() - t < maxAgeMs) return body
  } catch { /* not cached yet */ }
  const body = await load()
  await writeFile(file, JSON.stringify({ t: Date.now(), body }))
  return body
}

async function pool(items, n, fn) {
  let i = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k) }
  }))
}

// "2026-11-11 06:00:00" in an IANA zone -> epoch ms
function zoned(str, tz) {
  const [d, t] = str.split(' ')
  const [y, mo, da] = d.split('-').map(Number)
  const [h, mi, s] = t.split(':').map(Number)
  let guess = Date.UTC(y, mo - 1, da, h, mi, s || 0)
  for (let k = 0; k < 2; k++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(guess)).map(x => [x.type, x.value]))
    const shown = Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
    guess += Date.UTC(y, mo - 1, da, h, mi, s || 0) - shown
  }
  return guess
}

function xmltvTime(s) {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\s*([+-])?(\d\d)?(\d\d)?/.exec(s || '')
  if (!m) return NaN
  const t = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  return m[7] ? t - (m[7] === '-' ? -1 : 1) * ((+m[8]) * 60 + (+m[9])) * 60000 : t
}
const unesc = s => (s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&').trim()
const tag = (block, name) => unesc((block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1])

/* ---------------- channels ---------------- */

async function loadData() {
  log('Downloading iptv-org data')
  const [channels, feeds, streams, logos, guides, cities, subdivisions, regions, blocklist] = await Promise.all(
    ['channels', 'feeds', 'streams', 'logos', 'guides', 'cities', 'subdivisions', 'regions', 'blocklist'].map(n => json(API + n + '.json')))
  return { channels, feeds, streams, logos, guides, cities, subdivisions, regions, blocklist }
}

function buildChannels(d) {
  const ch = new Map(d.channels.map(c => [c.id, c]))
  const feedBy = new Map(d.feeds.map(f => [f.channel + '@' + f.id, f]))
  const mainFeed = new Map(d.feeds.filter(f => f.is_main).map(f => [f.channel, f]))
  const regions = new Map(d.regions.map(r => [r.code, r]))
  const cities = new Map(d.cities.map(c => [c.code, c]))
  const subs = new Map(d.subdivisions.map(s => [s.code, s]))
  const blocked = new Set(d.blocklist.map(b => b.channel))
  const inUS = a => a === 'c/US' || a.startsWith('s/US-') || a.startsWith('ct/US') ||
    (a.startsWith('r/') && (regions.get(a.slice(2))?.countries || []).includes('US'))

  const logoOf = new Map()
  for (const l of d.logos) {
    const k = l.feed ? l.channel + '@' + l.feed : l.channel
    const cur = logoOf.get(k)
    if (!cur || (l.in_use && !cur.in_use) || (l.width > cur.width && l.in_use === cur.in_use)) logoOf.set(k, l)
  }

  const out = new Map() // key -> entry
  for (const s of d.streams) {
    const c = s.channel && ch.get(s.channel)
    if (!c || c.country !== 'US' || c.closed || c.is_nsfw || blocked.has(c.id) || s.user_agent || s.referrer) continue
    const feed = (s.feed && feedBy.get(s.channel + '@' + s.feed)) || mainFeed.get(s.channel)
    if (!feed || !feed.broadcast_area.some(inUS)) continue
    // US audience only: English or Spanish, and not the international editions of US networks.
    const langs = feed.languages || []
    if (langs.length && !langs.includes('eng') && !langs.includes('spa')) continue
    if (/\binternational\b|persian|farsi|\bUN Web\b/i.test(c.name)) continue
    const area = feed.broadcast_area.find(a => a.startsWith('ct/US')) || feed.broadcast_area.find(a => a.startsWith('s/US-'))
    // National feeds of one channel share an entry; local feeds stay separate.
    const key = area ? c.id + '@' + feed.id : c.id
    let e = out.get(key)
    if (!e) {
      let place = cityNews(c.name)
      if (area?.startsWith('ct/')) {
        const city = cities.get(area.slice(3))
        if (city) place = { city: city.name, state: subs.get(city.subdivision)?.name || city.subdivision }
      } else if (area) place = { city: 'Statewide', state: subs.get(area.slice(2))?.name || area.slice(2) }
      const logo = logoOf.get(key) || logoOf.get(c.id)
      e = { key, ch: c, feed, title: s.title, place, local: !!place, streams: [], logo: logo?.url || '' }
      out.set(key, e)
    }
    e.streams.push(s)
  }
  for (const e of out.values()) {
    const q = s => parseInt(s.quality) || 0
    e.streams.sort((a, b) => (a.labels.includes('Geo-blocked') - b.labels.includes('Geo-blocked')) || q(b) - q(a))
  }
  return [...out.values()]
}

// Reads up to `limit` bytes of a URL and returns how fast they arrived.
async function speedTest(url, limit) {
  const t = Date.now()
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })
  if (!res.ok || !res.body) return 0
  let bytes = 0
  const reader = res.body.getReader()
  while (bytes < limit) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.length
  }
  reader.cancel().catch(() => {})
  return bytes < 50000 ? 0 : bytes * 8 / Math.max(1, Date.now() - t) // kbit/s
}

// Opens a stream like the TV would: playlist, quality levels, and a timed chunk of
// the newest video segment. headroom = download speed / bitrate needed to play.
async function measure(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) })
  const body = res.ok ? await res.text() : ''
  if (!/#EXTM3U/.test(body)) return { ok: /^\s*<\?xml|<MPD/i.test(body), levels: 0, headroom: 0 }
  let media = { url: res.url, body }, levels = 1, need = 0
  if (/#EXT-X-STREAM-INF/.test(body)) {
    const lines = body.split(/\r?\n/), vars = []
    lines.forEach((l, i) => { if (l.startsWith('#EXT-X-STREAM-INF')) vars.push({ bw: +(l.match(/BANDWIDTH=(\d+)/) || [])[1] || 0, uri: lines[i + 1]?.trim() }) })
    levels = vars.length
    vars.sort((a, b) => b.bw - a.bw)
    const top = vars.find(v => v.uri)
    if (!top) return { ok: true, levels, headroom: 0 }
    need = top.bw / 1000
    const r = await fetch(new URL(top.uri, res.url), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) })
    media = { url: r.url, body: await r.text() }
  }
  const segs = media.body.split(/\r?\n/).filter(l => l && !l.startsWith('#'))
  if (!segs.length) return { ok: true, levels, headroom: 0 }
  const kbps = await speedTest(new URL(segs[segs.length - 1], media.url).href, 600000)
  if (!need) need = 1500 // no declared bitrate: assume a typical 720p stream
  return { ok: true, levels, headroom: +(kbps / need).toFixed(1) }
}

// A stream is smooth when it adapts to the connection (several quality levels) or its
// server sends video at least 3x faster than it plays. Below 1.2x it cannot keep up.
const SLOW = 1.2
const streamScore = s => (s.levels > 1 ? 10 : 0) + Math.min(s.headroom || 0, 10) - (s.labels.includes('Geo-blocked') ? 5 : 0)

async function checkStreams(entries) {
  const all = entries.flatMap(e => e.streams.map(s => ({ e, s })))
  log(`Testing ${all.length} streams (Ctrl+C to stop; --no-check skips this)`)
  // Results stay valid for 12 hours, so each rebuild only retests a share of the streams.
  const file = join(CACHE, 'stream-tests.json')
  let known = {}
  try { known = JSON.parse(await readFile(file, 'utf8')) } catch { /* first run */ }
  let done = 0
  await pool(all, 12, async ({ s }) => {
    const k = known[s.url]
    if (k && Date.now() - k.t < 12 * 3600e3) Object.assign(s, k.r)
    else {
      let r
      try { r = await measure(s.url) } catch { r = { ok: false, levels: 0, headroom: 0 } }
      Object.assign(s, r)
      known[s.url] = { t: Date.now(), r }
    }
    if (++done % 250 === 0) log(`  ${done}/${all.length}`)
  })
  await writeFile(file, JSON.stringify(known))
  let dropped = 0
  for (const e of entries) {
    const ok = e.streams.filter(s => s.ok)
    // Streams too slow to keep up only stay when nothing better exists for the channel.
    const fast = ok.filter(s => s.levels > 1 || s.headroom >= SLOW)
    dropped += ok.length - (fast.length ? fast.length : ok.length)
    e.streams = (fast.length ? fast : ok).sort((a, b) => streamScore(b) - streamScore(a))
    const best = e.streams[0]
    e.smooth = !!best && (best.levels > 1 || best.headroom >= 3)
  }
  log(`  ${dropped} streams dropped as too slow to play smoothly`)
  return entries.filter(e => e.streams.length)
}

/* ---------------- guide ---------------- */

async function mjhFile(path) {
  return cached('mjh-' + path, 3 * 3600e3, () => text(`${MJH}/${path}.xml`, { timeout: 120000 }))
}

// Programmes from one i.mjh.nz file for the wanted site ids. Plex ids are
// "<provider>-<channel>" and the provider half changes, so match on the channel half too.
function mjhProgrammes(xml, wanted, from, to) {
  const tail = id => id.slice(id.lastIndexOf('-') + 1)
  const byTail = new Map()
  for (const [id, keys] of wanted) if (id.includes('-')) byTail.set(tail(id), keys)
  const res = new Map()
  for (const m of xml.matchAll(/<programme\b([^>]*)>([\s\S]*?)<\/programme>/g)) {
    const ch = (m[1].match(/channel="([^"]*)"/) || [])[1]
    const keys = wanted.get(ch) || (ch?.includes('-') ? byTail.get(tail(ch)) : undefined)
    if (!keys) continue
    const start = xmltvTime((m[1].match(/start="([^"]*)"/) || [])[1])
    const stop = xmltvTime((m[1].match(/stop="([^"]*)"/) || [])[1])
    if (!(stop > from && start < to)) continue
    const sub = tag(m[2], 'sub-title')
    const item = [start, stop, tag(m[2], 'title'), (sub ? sub + '. ' : '') + tag(m[2], 'desc').slice(0, 240), tag(m[2], 'category')]
    for (const k of keys) { if (!res.has(k)) res.set(k, []); res.get(k).push(item) }
  }
  return res
}

const attr = (s, n) => unesc((s.match(new RegExp(`data-${n}="([^"]*)"`, 'i')) || [])[1])

async function tvpassport(siteId, days) {
  const items = []
  for (let k = 0; k < days; k++) {
    const day = new Date(Date.now() + k * 86400e3).toISOString().slice(0, 10)
    let html
    try {
      html = await cached(`tvp-${siteId}-${day}`, 6 * 3600e3, () => text(`https://www.tvpassport.com/tv-listings/stations/${siteId}/${day}`, { timeout: 20000 }))
    } catch { continue }
    const tz = (html.match(/<option value="([^"]+)" selected/) || [])[1] || 'America/New_York'
    for (const m of html.matchAll(/<div[^>]*class="list-group-item"[^>]*>/g)) {
      const st = attr(m[0], 'st'), dur = parseInt(attr(m[0], 'duration'))
      if (!st || !dur) continue
      const start = zoned(st, tz)
      let title = attr(m[0], 'showName'), ep = attr(m[0], 'episodeTitle')
      if (/^(movie|cin[ée]ma)$/i.test(title) && ep) { title = ep; ep = '' }
      const team = [attr(m[0], 'team1'), attr(m[0], 'team2')].filter(Boolean).join(' vs ')
      const desc = [ep, team, attr(m[0], 'description')].filter(Boolean).join('. ').slice(0, 240)
      items.push([start, start + dur * 60000, title, desc, attr(m[0], 'showType').split(',')[0].trim()])
    }
  }
  const seen = new Set()
  return items.filter(p => !seen.has(p[0]) && seen.add(p[0])).sort((a, b) => a[0] - b[0])
}

async function buildGuide(entries, data) {
  const from = Date.now() - 3 * 3600e3, to = Date.now() + DAYS * 86400e3
  const guide = {}, note = {}

  // Guide index: one source per channel, preferring sources we can read.
  const byKey = new Map()
  for (const g of data.guides) {
    if (!g.channel || !['i.mjh.nz', 'tvpassport.com'].includes(g.site)) continue
    for (const k of [g.channel + '@' + g.feed, g.channel]) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(g) }
  }
  // tvpassport's station list: by call sign, by iptv-org id, and by plain name.
  const tvpList = await cached('tvpassport-channels', 7 * 86400e3, () => text(TVP_LIST))
  const byCall = new Map(), byXmltv = new Map(), byName = new Map()
  const norm = s => s.toLowerCase().replace(/\bhd\b|\btelevision\b|\bchannel\b|[^a-z0-9]/g, '')
  for (const m of tvpList.matchAll(/site_id="([^"]+)"[^>]*xmltv_id="([^"]*)"[^>]*>([^<]*)</g)) {
    const [, sid, xid, label] = m
    if (/canada/.test(sid)) continue
    const base = sid.replace(/-hd\//, '/')
    const cs = (label.match(/\(([KW][A-Z]{2,3})(?:-(?:TV|DT|CD|LD|LP|CA))?\)/) || [])[1]
    if (cs && !byCall.has(cs)) byCall.set(cs, base)
    if (xid) for (const k of [xid, xid.split('@')[0]]) if (!byXmltv.has(k)) byXmltv.set(k, base)
    if (!label.includes('(') && !byName.has(norm(label))) byName.set(norm(label), base)
  }

  // Every source we could use for each channel, best first.
  const cands = new Map()
  for (const e of entries) {
    const list = [...(byKey.get(e.key) || []), ...(byKey.get(e.ch.id + '@' + e.feed.id) || []), ...(byKey.get(e.ch.id) || [])]
    const c = []
    for (const g of list.filter(x => x.site === 'i.mjh.nz').sort((a, b) => (b.lang === 'en') - (a.lang === 'en'))) {
      const [path, id] = g.site_id.split('#'); c.push({ mjh: path, id })
    }
    for (const s of e.streams) {
      const pluto = (s.url.match(/jmp2\.uk\/plu-([0-9a-f]{24})/) || [])[1]
      if (pluto) c.push({ mjh: 'PlutoTV/us', id: pluto })
    }
    for (const g of list.filter(x => x.site === 'tvpassport.com')) c.push({ tvp: g.site_id })
    const local = byXmltv.get(e.ch.id + '@' + e.feed.id) || (!e.local && byXmltv.get(e.ch.id))
    if (local) c.push({ tvp: local })
    const call = (e.title.match(/\b([KW][A-Z]{2,3})(?:-(?:TV|DT|CD|LD|LP))?\b/) || [])[1] ||
      (/^[KW][A-Z]{2,3}/.test(e.feed.id) ? e.feed.id.replace(/(TV|DT|HD|SD|LD|CD)$/, '') : '')
    if (call && byCall.has(call)) c.push({ tvp: byCall.get(call) })
    if (!e.local) for (const n of [e.ch.name, ...(e.ch.alt_names || [])]) if (byName.has(norm(n))) c.push({ tvp: byName.get(norm(n)) })
    cands.set(e.key, c)
  }

  const want = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v) }
  const mjhWanted = new Map() // path -> Map(siteId -> [keys])
  for (const [key, c] of cands) for (const s of c) if (s.mjh) {
    if (!mjhWanted.has(s.mjh)) mjhWanted.set(s.mjh, new Map())
    want(mjhWanted.get(s.mjh), s.id, key)
  }

  for (const [path, wanted] of mjhWanted) {
    try {
      const got = mjhProgrammes(await mjhFile(path), wanted, from, to)
      for (const [k, v] of got) if (!guide[k] || v.length > guide[k].length) guide[k] = v
      log(`  i.mjh.nz ${path}: ${got.size} channels`)
    } catch (err) { log(`  i.mjh.nz ${path}: skipped (${err.message})`) }
  }

  // Channels still empty try their tvpassport stations, one after another.
  const tvpWanted = new Map() // siteId -> [keys]
  const nextTvp = new Map()
  for (const [key, c] of cands) {
    if (guide[key]) continue
    const list = [...new Set(c.filter(s => s.tvp).map(s => s.tvp))]
    if (list.length) { nextTvp.set(key, list.slice(1)); want(tvpWanted, list[0], key) }
  }
  for (const [key, rest] of nextTvp) for (const sid of rest) want(tvpWanted, sid, key)

  const sites = [...tvpWanted.keys()]
  log(`  tvpassport.com: ${sites.length} stations, ${DAYS} days each`)
  let n = 0
  await pool(sites, 4, async siteId => {
    const items = (await tvpassport(siteId, DAYS)).filter(p => p[1] > from && p[0] < to)
    if (items.length) for (const k of tvpWanted.get(siteId)) if (!guide[k]) guide[k] = items
    if (++n % 50 === 0) log(`    ${n}/${sites.length}`)
  })

  // Affiliates with no schedule: borrow the network's from another station in the same zone.
  const NET = /^(ABC|NBC|CBS|FOX|CW|PBS|MyNetworkTV|ION|Telemundo|Univision)\.us$/
  const donors = new Map()
  for (const e of entries) if (NET.test(e.ch.id) && guide[e.key]) want(donors, e.ch.id + '|' + (e.feed.timezones || [])[0], e)
  for (const e of entries) {
    if (guide[e.key] || !NET.test(e.ch.id)) continue
    const tz = (e.feed.timezones || [])[0]
    const donor = (donors.get(e.ch.id + '|' + tz) || [])[0] || [...donors.entries()].find(([k]) => k.startsWith(e.ch.id + '|'))?.[1][0]
    if (!donor) continue
    guide[e.key] = guide[donor.key]
    note[e.key] = `${e.ch.name} network schedule from ${donor.title}; local news times may differ`
  }
  return { guide, note }
}

/* ---------------- folders ---------------- */

function buildFolders(entries) {
  const root = { name: 'Home', children: new Map(), channels: [] }
  for (const e of entries) {
    for (const path of e.paths) {
      let node = root
      for (const part of path) {
        if (!node.children.has(part)) node.children.set(part, { name: part, children: new Map(), channels: [] })
        node = node.children.get(part)
      }
      node.channels.push(e.key)
    }
  }
  const rank = (order, name) => { const i = order.indexOf(name); return i < 0 ? 999 : i }
  const newsRank = name => { const i = NATIONAL_NEWS_ORDER.findIndex(re => re.test(name)); return i < 0 ? 999 : i }
  const nameOf = new Map(entries.map(e => [e.key, e.ch.name]))
  const finish = (node, depth, top) => {
    const kids = [...node.children.values()]
    kids.sort((a, b) => depth === 0 ? rank(TOP_ORDER, a.name) - rank(TOP_ORDER, b.name)
      : top === 'Sports' ? rank(SPORTS_ORDER, a.name) - rank(SPORTS_ORDER, b.name)
      : top === 'National News' ? rank(NEWS_ORDER, a.name) - rank(NEWS_ORDER, b.name)
      : a.name === 'National' ? -1 : b.name === 'National' ? 1 : a.name.localeCompare(b.name))
    node.channels.sort((a, b) => (top === 'National News' ? newsRank(nameOf.get(a)) - newsRank(nameOf.get(b)) : 0) || nameOf.get(a).localeCompare(nameOf.get(b)))
    const out = { name: node.name }
    if (kids.length) out.folders = kids.map(k => finish(k, depth + 1, depth === 0 ? k.name : top))
    if (node.channels.length) out.channels = node.channels
    out.count = new Set([...(node.channels), ...(out.folders || []).flatMap(f => f.all)]).size
    Object.defineProperty(out, 'all', { value: [...node.channels, ...(out.folders || []).flatMap(f => f.all)], enumerable: false })
    return out
  }
  return finish(root, 0, '')
}

/* ---------------- main ---------------- */

async function main() {
  await mkdir(CACHE, { recursive: true })
  const data = await loadData()
  let entries = buildChannels(data)
  log(`  ${entries.length} US channels before testing streams`)
  if (CHECK) entries = await checkStreams(entries)
  log(`  ${entries.length} channels with a working stream`)

  for (const e of entries) e.paths = classify(e)

  log('Building guide')
  const { guide, note } = await buildGuide(entries, data)

  const nums = [...entries].sort((a, b) => a.ch.name.localeCompare(b.ch.name))
  nums.forEach((e, i) => { e.num = i + 1 })
  const channels = {}
  for (const e of entries) {
    const folder = e.paths[0][0]
    channels[e.key] = {
      num: e.num,
      // Local stations are known by their stream title, e.g. "ABC 6 Austin TX (KAAL)".
      name: e.local ? e.title.replace(/\s*\(\d+p\)|\s*\[[^\]]*\]/g, '').trim() : e.ch.name,
      logo: e.logo,
      urls: e.streams.map(s => s.url),
      geo: e.streams.every(s => s.labels.includes('Geo-blocked')),
      part: e.streams.every(s => s.labels.includes('Not 24/7')),
      smooth: e.smooth !== false,
      place: e.place ? `${e.place.city}, ${e.place.state}` : '',
      kind: e.paths.map(p => p.join(' > ')).join(' · '),
      about: describe({ ch: e.ch, local: e.local, place: e.place, folder }),
      note: note[e.key] || ''
    }
  }
  const folders = buildFolders(entries)
  const withGuide = entries.filter(e => guide[e.key]?.length).length

  await writeFile(join(OUT, 'lineup.json'), JSON.stringify({ built: Date.now(), folders, channels }))
  const gjson = JSON.stringify({ built: Date.now(), channels: guide })
  await writeFile(join(OUT, 'guide.json'), gjson)
  // The next 15 hours only: what the TV downloads, small enough for an older TV.
  await writeFile(join(OUT, 'guide-window.json'), guideWindow(guide, 15))
  log(`\nWrote ${join(OUT, 'lineup.json')}: ${entries.length} channels in ${folders.folders.length} folders`)
  log(`Wrote ${join(OUT, 'guide.json')}: schedules for ${withGuide} channels, ${(gjson.length / 1e6).toFixed(1)} MB`)
  log(`${entries.length - withGuide} channels publish no schedule; the app describes what they carry instead.`)
  for (const f of folders.folders) log(`  ${f.name}: ${f.count}${f.folders ? ' (' + f.folders.map(x => `${x.name} ${x.count}`).join(', ') + ')' : ''}`)
}

main().catch(e => { console.error(e); process.exit(1) })
