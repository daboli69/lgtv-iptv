// Programmes from an hour ago to `hours` ahead, as the JSON the TV app reads.
// Used by build-lineup.mjs (guide-window.json) and serve-guide.mjs.
export function guideWindow(all, hours) {
  const from = Date.now() - 3600e3, to = Date.now() + hours * 3600e3
  const channels = {}
  for (const k in all) {
    const list = all[k].filter(p => p[1] > from && p[0] < to)
    if (list.length) channels[k] = list
  }
  return JSON.stringify({ built: Date.now(), from, to, channels })
}
