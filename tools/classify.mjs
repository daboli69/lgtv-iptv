// Sorts a US channel into the folders the TV app shows.
// Returns a list of folder paths, e.g. [['Sports', 'Football'], ['Sports', 'Sports Networks']].

const has = (re, s) => re.test(s)

const SPORT_FOLDERS = [
  ['Football', /\bNFL\b|football|\bXFL\b|\bUFL\b|red ?zone|gridiron/i],
  ['Basketball', /\bW?NBA\b|basketball|hoops|g league/i],
  ['Baseball', /\bMLB\b|baseball|milb/i],
  ['Hockey', /\bNHL\b|hockey/i],
  ['Soccer', /soccer|\bMLS\b|f[uú]tbol|golazo|\bFIFA\b|premier league|\bliga\b|bein/i],
  ['College Sports', /college|\bNCAA\b|\bACC\b|big ten|\bSEC\b|pac-?12|university|campus|longhorn|\bHBCU\b/i],
  ['Fighting & Wrestling', /boxing|\bMMA\b|\bUFC\b|wrestl|\bWWE\b|\bAEW\b|fight|\bFITE\b|combat|\bXFC\b|unbeaten|\bPFL\b|bellator|kickbox|karate|\bTNA\b/i],
  ['Motorsports', /racing|racer|nascar|\bF1\b|formula|motorsport|speedway|drag ?race|\bNHRA\b|indycar|rally|supercross|motocross|motorvision|rev'?n|turbo/i],
  ['Golf', /golf|\bPGA\b/i],
  ['Tennis & Pickleball', /tennis|pickleball/i],
  ['Outdoors, Hunting & Fishing', /fishing|hunting|outdoor|angler|\bbass\b|sportsman|wild/i],
  ['Sports Networks', /espn|\bFS[12]\b|fox sports|cbs sports|nbc sports|tnt sports|stadium|yahoo sports|sportsgrid|sportsnet|bally|\bmsg\b|\bnesn\b|\bYES\b|marquee|altitude|sny|monumental|fanduel/i]
]

// Channels people expect at the top of National News, in this order.
export const NATIONAL_NEWS_ORDER = [
  /^CNN\b(?!.*(international|en espa|latino))/i, /fox news/i, /msnbc|ms ?now/i, /nbc news/i, /abc news/i, /cbs news/i,
  /newsnation/i, /newsmax/i, /scripps news/i, /livenow/i, /bloomberg/i, /\bcnbc\b/i, /fox business/i,
  /weather channel/i, /fox weather/i, /c-?span/i, /reuters/i, /yahoo/i, /court tv/i
]

export const NEWS_ORDER = ['Top Networks', 'Business & Finance', 'Weather', 'More News']

// Streaming news channels for one city that iptv-org lists as national.
const CITY_NEWS = [
  [/^CBS News Baltimore/i, 'Baltimore', 'Maryland'], [/^CBS News Bay Area/i, 'San Francisco', 'California'],
  [/^CBS News Boston/i, 'Boston', 'Massachusetts'], [/^CBS News Chicago/i, 'Chicago', 'Illinois'],
  [/^CBS News Colorado/i, 'Denver', 'Colorado'], [/^CBS News Detroit/i, 'Detroit', 'Michigan'],
  [/^CBS News Los Angeles/i, 'Los Angeles', 'California'], [/^CBS News Miami/i, 'Miami', 'Florida'],
  [/^CBS News Minnesota/i, 'Minneapolis', 'Minnesota'], [/^CBS News New York/i, 'New York', 'New York'],
  [/^CBS News Philly/i, 'Philadelphia', 'Pennsylvania'], [/^CBS News Pittsburgh/i, 'Pittsburgh', 'Pennsylvania'],
  [/^CBS News Sacramento/i, 'Sacramento', 'California'], [/^CBS News Texas/i, 'Dallas', 'Texas'],
  [/^CBS News Atlanta/i, 'Atlanta', 'Georgia'], [/^News ?12 (Brooklyn|Bronx)/i, 'New York', 'New York'],
  [/^News ?12 Long Island/i, 'Long Island', 'New York'], [/^News ?12 Westchester/i, 'Westchester', 'New York'],
  [/^News ?12 Hudson Valley/i, 'Hudson Valley', 'New York'], [/^News ?12 New York/i, 'New York', 'New York'],
  [/^News ?12 New Jersey/i, 'Statewide', 'New Jersey'], [/^News ?12 Conn?ecticut/i, 'Statewide', 'Connecticut'],
  [/^WSOC/i, 'Charlotte', 'North Carolina']
]
export function cityNews(name) {
  const hit = CITY_NEWS.find(([re]) => re.test(name))
  return hit ? { city: hit[1], state: hit[2] } : null
}

export const SPORTS_ORDER = ['Football', 'Basketball', 'Sports Networks', 'Baseball', 'Hockey', 'Soccer', 'College Sports',
  'Fighting & Wrestling', 'Motorsports', 'Golf', 'Tennis & Pickleball', 'Outdoors, Hunting & Fishing', 'More Sports']

export const TOP_ORDER = ['Sports', 'National News', 'Local News', 'Movies', 'TV Shows', 'Kids & Family', 'Music',
  'Documentary & Science', 'Lifestyle', 'En Español', 'Religious', 'Community & Government', 'More Channels']

const BROADCAST_NETWORKS = /^(ABC|NBC|CBS|FOX|CW|PBS|MyNetworkTV|ION|Telemundo|Univision|UniMas|Estrella|MeTV|Antenna)\.us$/

export function classify({ ch, feed, title, local, place }) {
  const cats = ch.categories || []
  const text = [ch.name, title, ch.id, ch.network || '', (ch.alt_names || []).join(' ')].join(' ')
  const spanish = ((feed.languages || []).includes('spa') && !(feed.languages || []).includes('eng')) ||
    /deportes|espa[nñ]ol|latino|telemundo|univision|unimas|estrella/i.test(ch.name + ' ' + ch.id)
  const paths = []

  if (spanish) return [['En Español']]

  if (cats.includes('sports') || SPORT_FOLDERS.slice(0, 10).some(([, re]) => has(re, ch.name))) {
    for (const [name, re] of SPORT_FOLDERS) if (has(re, text)) paths.push(['Sports', name])
    if (!paths.length && cats.includes('sports')) paths.push(['Sports', 'More Sports'])
    if (paths.length) return paths
  }

  if (local) {
    if (cats.includes('religious')) return [['Religious']]
    const community = cats.some(c => ['legislative', 'education', 'culture'].includes(c)) ||
      /access|\bPAC\b|\bPEG\b|community|council|govern|city ?tv|citytv|city of|city channel|county|public|school|college|university|cmap|\bTAP\b|coast ?side|currents|\bTV ?\d+$|channel \d+/i.test(text)
    // A local news station is a network affiliate, a call-sign station or a news channel.
    const station = BROADCAST_NETWORKS.test(ch.id) || /\b[KW][A-Z]{2,3}(-(TV|DT|CD|LD))?\b/.test(title) ||
      /^CBS News|^News ?12|news/i.test(ch.name) || cats.some(c => ['news', 'weather'].includes(c))
    if (station && !community) return [['Local News', place.state, place.city]]
    return [['Community & Government', place.state]]
  }

  if (cats.some(c => ['news', 'business', 'weather'].includes(c)) || BROADCAST_NETWORKS.test(ch.id)) {
    const name = ch.name
    if (!/ABC News Live \d/i.test(name) && NATIONAL_NEWS_ORDER.slice(0, 10).some(re => re.test(name))) return [['National News', 'Top Networks']]
    if (cats.includes('weather') || /weather/i.test(name)) return [['National News', 'Weather']]
    if (cats.includes('business') || /bloomberg|cnbc|fox business|finance|market|invest|schwab|ameritrade|money/i.test(name)) return [['National News', 'Business & Finance']]
    return [['National News', 'More News']]
  }
  if (cats.includes('legislative')) return [['Community & Government', 'National']]
  if (cats.includes('movies')) return [['Movies']]
  if (cats.some(c => ['kids', 'animation', 'family'].includes(c))) return [['Kids & Family']]
  if (cats.includes('music')) return [['Music']]
  if (cats.includes('religious')) return [['Religious']]
  if (cats.some(c => ['documentary', 'science', 'education'].includes(c)) || /history|nature|science|docu/i.test(text)) return [['Documentary & Science']]
  if (cats.some(c => ['lifestyle', 'cooking', 'travel', 'auto', 'outdoor', 'relax', 'shop', 'culture'].includes(c))) return [['Lifestyle']]
  if (cats.some(c => ['series', 'comedy', 'classic', 'entertainment', 'general'].includes(c))) {
    if (/crime|mystery|cops|detective|forensic|unsolved|dateline|48 hours|murder|court|justice|csi|law ?& ?order/i.test(text)) return [['TV Shows', 'Crime & Mystery']]
    if (/game show|price is right|family feud|deal or no|jeopardy|wheel|reality|real ?housewives|survivor|big brother|antiques|bounty|pawn|storage/i.test(text)) return [['TV Shows', 'Reality & Game Shows']]
    if (cats.includes('comedy') || /comedy|laugh|sitcom|funny|snl|conan|kevin hart/i.test(text)) return [['TV Shows', 'Comedy']]
    if (cats.includes('classic') || /classic|retro|\b[5-9]0s\b|rewind|throwback|vintage/i.test(text)) return [['TV Shows', 'Classic TV']]
    return [['TV Shows', 'Drama & More']]
  }
  return [['More Channels']]
}

// One line saying what a channel carries, for channels that publish no schedule.
export function describe({ ch, local, place, folder }) {
  const cats = (ch.categories || []).filter(c => c !== 'general')
  const kind = cats.length ? cats.join(', ') : folder.toLowerCase()
  if (local && folder === 'Community & Government') return `Community channel for ${place.city}, ${place.state}: local government meetings, events and public programming.`
  if (local) return `Local station for ${place.city}, ${place.state}: news, weather and network shows.`
  return `Live ${kind} channel, streaming around the clock.`
}
