/* IPTV Guide for LG webOS.
   Plain ES5 on purpose: webOS 4.x runs a Chromium 53 engine (no async/await, no object spread).

   tools/build-lineup.mjs builds lineup.json (US channels in folders) and guide-window.json
   (schedules). A GitHub Actions job publishes them online every 3 hours; the PC can serve
   them too with tools/serve-guide.mjs. The app tries online first, then the PC, then falls
   back to iptv-org's US playlist so there is always something to watch. */
(function () {
  'use strict';

  var FALLBACK_PLAYLIST = 'https://iptv-org.github.io/iptv/countries/us.m3u';
  var ONLINE = 'https://daboli69.github.io/lgtv-iptv';
  var DEFAULT_SERVER = 'http://192.168.1.95:8787';
  var ROWS = 6;              // channel rows on screen
  var HOME_ROWS = 8;         // folder rows on screen
  var SLOT = 30 * 60000;     // half-hour columns
  var WINDOW = 4 * SLOT;     // two hours across
  var TRACK_W = 1728 - 304;  // grid width minus the channel column
  var STALL_MS = 15000;
  var GUIDE_HOURS = 12;

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 461, ESC: 27, BKSP: 8,
    CH_UP: 33, CH_DOWN: 34, RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406, INFO: 457 };

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video');

  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('iptv.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('iptv.' + k, JSON.stringify(v)); } catch (e) { /* storage off: lasts this session only */ } }
  };

  var S = {
    server: store.get('server', DEFAULT_SERVER),
    online: store.get('online', ONLINE),
    base: '',         // where the lineup came from; the guide is read from the same place
    hideEmpty: store.get('hideEmpty', false),
    favs: store.get('favs2', {}),
    channels: {},     // key -> channel
    tree: null,       // folder tree
    source: 'none',   // lineup | playlist | none
    guide: {},        // key -> [[start, stop, title, desc, category]]
    guideState: 'none',
    stack: [],        // folder path on the home screen
    sel: [0],         // focused row per level
    list: [],         // channels in the guide
    listName: '',
    row: 0, top: 0,
    t: Date.now(), winStart: 0,
    screen: 'home',   // home | guide
    full: false,
    overlay: null,
    tuned: null, urlIdx: 0,
    stallTimer: null, bannerTimer: null
  };

  /* ---------- loading ---------- */

  function get(url, timeout, done) {
    var x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.timeout = timeout;
    x.onload = function () {
      if ((x.status >= 200 && x.status < 300) || (x.status === 0 && x.responseText)) done(null, x.responseText);
      else done(new Error('HTTP ' + x.status));
    };
    x.onerror = function () { done(new Error('no answer')); };
    x.ontimeout = function () { done(new Error('timed out')); };
    x.send();
  }

  // Online copy first, then the PC, then the plain playlist.
  function loadLineup() {
    var bases = [S.online, S.server].filter(Boolean);
    homeMessage('Loading channels', '');
    (function attempt(i) {
      if (i >= bases.length) {
        notice('Channel list not reachable, showing the basic iptv-org list. Check Settings.');
        return loadPlaylist();
      }
      get(bases[i] + '/lineup.json', 20000, function (err, text) {
        var data = null;
        if (!err) { try { data = JSON.parse(text); } catch (e) { data = null; } }
        if (!data || !data.folders) return attempt(i + 1);
        S.channels = {};
        for (var k in data.channels) { var c = data.channels[k]; c.key = k; S.channels[k] = c; }
        S.tree = data.folders;
        S.source = 'lineup';
        S.base = bases[i];
        notice('');
        ready();
      });
    })(0);
  }

  // Fallback: iptv-org's US playlist, foldered by its group titles.
  function loadPlaylist() {
    get(FALLBACK_PLAYLIST, 30000, function (err, text) {
      if (err) {
        S.source = 'none';
        homeMessage('No channels', 'The TV could not reach the channel list or iptv-org. Check the internet connection, then press Yellow and choose Reload.');
        return;
      }
      var lines = text.split(/\r?\n/), cur = null, n = 0, groups = {};
      S.channels = {};
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i].trim();
        if (l.indexOf('#EXTINF') === 0) {
          var id = (l.match(/tvg-id="([^"]*)"/) || [])[1] || '';
          var g = ((l.match(/group-title="([^"]*)"/) || [])[1] || 'Other').split(';')[0];
          var name = l.slice(l.lastIndexOf(',') + 1);
          cur = { id: id, group: g, name: name.replace(/\s*\(\d+p\)/g, '').replace(/\s*\[[^\]]*\]/g, '').trim(),
            geo: /Geo-blocked/i.test(name), part: /Not 24\/7/i.test(name), place: '', kind: g, about: 'Live ' + g.toLowerCase() + ' channel.', note: '' };
        } else if (cur && l && l.charAt(0) !== '#') {
          cur.urls = [l]; cur.key = l; cur.num = ++n;
          S.channels[l] = cur;
          (groups[cur.group] = groups[cur.group] || []).push(l);
          cur = null;
        }
      }
      var names = Object.keys(groups).sort();
      S.tree = { name: 'Channels', folders: names.map(function (g) { return { name: g, channels: groups[g], count: groups[g].length }; }), count: n };
      S.source = 'playlist';
      ready();
    });
  }

  function loadGuide() {
    if (S.source === 'none') return;
    S.guideState = 'loading';
    // The plain playlist has no guide of its own; borrow the online one if it answers.
    var base = S.base || S.online || S.server;
    get(base + '/guide-window.json', 60000, function (err, text) {
      if (err) { S.guideState = 'error'; return redraw(); }
      try {
        var ch = JSON.parse(text).channels, g = {};
        for (var id in ch) { g[id] = ch[id]; var base = id.split('@')[0]; if (!g[base]) g[base] = ch[id]; }
        S.guide = g;
        S.guideState = 'ok';
      } catch (e) { S.guideState = 'error'; }
      redraw();
    });
  }

  function ready() {
    S.stack = [S.tree];
    S.sel = [0];
    var last = store.get('lastKey', null);
    if (last && S.channels[last]) S.tuned = S.channels[last];
    S.screen = 'home';
    setScreen();
    drawHome();
    loadGuide();
  }

  /* ---------- folders ---------- */

  function keysOf(node) {
    if (node.virtual) return node.keys;
    var out = (node.channels || []).slice();
    (node.folders || []).forEach(function (f) { out = out.concat(keysOf(f)); });
    var seen = {};
    return out.filter(function (k) { if (seen[k] || !S.channels[k]) return false; seen[k] = 1; return true; });
  }

  function visible(keys) {
    return S.hideEmpty && S.guideState === 'ok' ? keys.filter(function (k) { return hasGuide(S.channels[k]); }) : keys;
  }

  function favNode() {
    var keys = Object.keys(S.favs).filter(function (k) { return S.channels[k]; });
    return { name: 'Favorites', virtual: true, keys: keys };
  }

  // Rows shown for the folder at the top of the stack.
  function homeRows() {
    var node = S.stack[S.stack.length - 1], rows = [];
    if (S.stack.length === 1) {
      if (S.tuned) rows.push({ type: 'resume', name: 'Back to ' + S.tuned.name, sub: nowLine(S.tuned) });
      var fav = favNode();
      rows.push({ type: 'folder', node: fav, name: 'Favorites', sub: fav.keys.length ? '' : 'Press Green on any channel to add it here', count: fav.keys.length });
    }
    (node.folders || []).forEach(function (f) {
      var n = visible(keysOf(f)).length;
      if (!n && S.hideEmpty) return;
      var sub = f.folders ? f.folders.slice(0, 5).map(function (x) { return x.name; }).join(', ') + (f.folders.length > 5 ? ' and more' : '') : '';
      rows.push({ type: 'folder', node: f, name: f.name, sub: sub, count: n });
    });
    if (node.channels && node.channels.length && node.folders && node.folders.length) {
      rows.push({ type: 'folder', node: { name: node.name, virtual: true, keys: node.channels }, name: 'Other ' + node.name + ' channels', sub: '', count: visible(node.channels).length });
    }
    if (S.stack.length > 1 && node.folders && node.folders.length > 1) {
      rows.push({ type: 'folder', node: { name: 'All ' + node.name, virtual: true, keys: keysOf(node) }, name: 'All ' + node.name, sub: 'Every channel in this folder, in one guide', count: visible(keysOf(node)).length });
    }
    return rows;
  }

  function nowLine(c) {
    var p = progAt(c, Date.now());
    return p ? 'Now: ' + p[2] : (c.place || c.kind || '');
  }

  function drawHome() {
    var rows = homeRows(), lvl = S.stack.length - 1;
    var sel = Math.min(S.sel[lvl] || 0, Math.max(0, rows.length - 1));
    S.sel[lvl] = sel;
    var node = S.stack[lvl];
    $('hTitle').textContent = lvl === 0 ? 'What to watch' : S.stack.slice(1).map(function (n) { return n.name; }).join(' › ');
    $('hMeta').textContent = lvl === 0
      ? (S.source === 'lineup' ? Object.keys(S.channels).length.toLocaleString('en-US') + ' US channels, sorted into folders' : S.source === 'playlist' ? 'Basic list from iptv-org' : '')
      : visible(keysOf(node)).length + ' channels';
    var start = Math.max(0, Math.min(sel - 3, rows.length - HOME_ROWS)), html = '';
    if (start > 0) html += '<li class="more">▲ ' + start + ' more above</li>';
    for (var i = start; i < Math.min(rows.length, start + HOME_ROWS); i++) {
      var r = rows[i];
      html += '<li class="' + (i === sel ? 'f' : '') + '"><div class="n">' + esc(r.name) + '</div>' +
        (r.sub ? '<div class="s">' + esc(r.sub) + '</div>' : '') +
        (r.count !== undefined ? '<div class="c">' + r.count + '</div>' : '') + '</li>';
    }
    if (start + HOME_ROWS < rows.length) html += '<li class="more">▼ ' + (rows.length - start - HOME_ROWS) + ' more below</li>';
    $('hList').innerHTML = html;
    setScreen();
    drawWatching();
  }

  function drawWatching() {
    var c = S.tuned;
    $('wLabel').textContent = c ? 'Now playing' : '';
    $('wName').textContent = c ? c.name : '';
    var p = c && progAt(c, Date.now());
    $('wNow').textContent = c ? (p ? p[2] + ', until ' + hhmm(p[1]) : c.about || '') : '';
  }

  function homeMessage(title, more) {
    S.screen = 'home';
    setScreen();
    $('hTitle').textContent = title;
    $('hMeta').textContent = more;
    $('hList').innerHTML = '';
  }

  function homeOK() {
    var rows = homeRows(), r = rows[S.sel[S.stack.length - 1]];
    if (!r) return;
    if (r.type === 'resume') return goFull();
    var node = r.node;
    if (!node.virtual && node.folders && node.folders.length) {
      S.stack.push(node);
      S.sel[S.stack.length - 1] = 0;
      return drawHome();
    }
    var keys = visible(keysOf(node));
    if (!keys.length) return notice(node.name === 'Favorites' ? 'No favorites yet. Press Green on a channel to add one.' : 'Nothing to show in ' + node.name + '.', 4000);
    openGuide(node.name, keys);
  }

  function homeBack() {
    if (S.stack.length > 1) { S.stack.pop(); return drawHome(); }
    exitApp();
  }

  /* ---------- guide model ---------- */

  function progsFor(c) { return (c && (S.guide[c.key] || (c.id && (S.guide[c.id] || S.guide[c.id.split('@')[0]])))) || null; }
  function hasGuide(c) { var p = progsFor(c); return !!(p && p.length); }

  function progAt(c, t) {
    var p = progsFor(c);
    if (!p) return null;
    for (var i = 0; i < p.length; i++) if (p[i][0] <= t && p[i][1] > t) return p[i];
    return null;
  }

  function resetWindow() { S.winStart = Math.floor(Date.now() / SLOT) * SLOT; }

  function keepInWindow() {
    var nowSlot = Math.floor(Date.now() / SLOT) * SLOT;
    if (S.t < Date.now()) S.t = Date.now();
    while (S.t < S.winStart && S.winStart > nowSlot) S.winStart -= SLOT;
    while (S.t >= S.winStart + WINDOW) S.winStart += SLOT;
  }

  function moveTime(dir) {
    var c = S.list[S.row], p = progsFor(c), cur = progAt(c, S.t);
    if (p && dir > 0) {
      var next = null;
      for (var i = 0; i < p.length; i++) if (p[i][0] >= (cur ? cur[1] : S.t)) { next = p[i]; break; }
      S.t = next ? next[0] : S.t + SLOT;
    } else if (p && dir < 0) {
      var prev = null, from = cur ? cur[0] : S.t;
      for (var j = p.length - 1; j >= 0; j--) if (p[j][1] <= from) { prev = p[j]; break; }
      S.t = prev ? Math.max(prev[0], Date.now()) : S.t - SLOT;
    } else {
      S.t += dir * SLOT;
    }
    if (S.t > Date.now() + (GUIDE_HOURS - 2) * 3600e3) S.t = Date.now() + (GUIDE_HOURS - 2) * 3600e3;
    keepInWindow();
    drawGuide();
  }

  function moveRow(d) {
    if (!S.list.length) return;
    S.row = Math.max(0, Math.min(S.list.length - 1, S.row + d));
    drawGuide();
  }

  function openGuide(name, keys) {
    S.list = keys.map(function (k) { return S.channels[k]; });
    S.listName = name;
    S.row = 0; S.top = 0;
    if (S.tuned) for (var i = 0; i < S.list.length; i++) if (S.list[i].key === S.tuned.key) { S.row = i; break; }
    S.t = Date.now();
    resetWindow();
    S.screen = 'guide';
    setScreen();
    drawGuide();
  }

  /* ---------- drawing ---------- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(t) { var d = new Date(t); var h = d.getHours(); return (h % 12 || 12) + ':' + pad(d.getMinutes()) + (h < 12 ? 'am' : 'pm'); }
  function esc(s) { return String(s || '').replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }
  function x(t) { return Math.round((Math.max(S.winStart, Math.min(S.winStart + WINDOW, t)) - S.winStart) / WINDOW * TRACK_W); }

  var noticeTimer = null;
  function notice(msg, ms) {
    $('notice').textContent = msg;
    clearTimeout(noticeTimer);
    if (ms) noticeTimer = setTimeout(function () { $('notice').textContent = ''; }, ms);
  }

  function setScreen() {
    var b = document.body.classList;
    b.toggle('homeMode', S.screen === 'home');
    b.toggle('guideMode', S.screen === 'guide');
    b.toggle('full', S.full);
    $('lBack').textContent = S.screen === 'guide' ? 'Back: folders' : S.stack.length > 1 ? 'Back: up a folder' : 'Back: exit';
  }

  function redraw() {
    if (S.overlay) return;
    if (S.screen === 'home' && S.tree) drawHome();
    if (S.screen === 'guide') drawGuide();
  }

  function liveCell(c, sel) {
    return '<div class="p live' + (sel ? ' f' : '') + '" style="left:0;width:' + TRACK_W + 'px">' +
      '<div class="t">Live now: ' + esc(c.name) + '</div><div class="s">' + esc(c.about || c.kind) + '</div></div>';
  }

  function drawGuide() {
    var st = $('state');
    if (!S.list.length) { st.innerHTML = 'No channels here'; $('rows').innerHTML = ''; return; }
    st.innerHTML = '';
    if (S.row < S.top) S.top = S.row;
    if (S.row >= S.top + ROWS) S.top = S.row - ROWS + 1;
    $('crumb').textContent = S.listName;

    var times = '';
    for (var k = 0; k < 4; k++) times += '<span style="left:' + (k * TRACK_W / 4) + 'px">' + hhmm(S.winStart + k * SLOT) + '</span>';
    $('times').innerHTML = times;

    var now = Date.now(), html = '';
    for (var r = S.top; r < Math.min(S.list.length, S.top + ROWS); r++) {
      var c = S.list[r], sel = r === S.row, p = progsFor(c), cells = '', any = false;
      if (p) {
        for (var i = 0; i < p.length; i++) {
          var a = p[i];
          if (a[1] <= S.winStart || a[0] >= S.winStart + WINDOW) continue;
          any = true;
          var cls = 'p' + (a[0] <= now && a[1] > now ? ' on' : '') + (sel && a[0] <= S.t && a[1] > S.t ? ' f' : '');
          var left = x(a[0]), w = x(a[1]) - left;
          cells += '<div class="' + cls + '" style="left:' + left + 'px;width:' + w + 'px">' +
            '<div class="t">' + (a[0] < S.winStart ? '‹ ' : '') + esc(a[2]) + '</div>' +
            '<div class="s">' + hhmm(a[0]) + ' to ' + hhmm(a[1]) + '</div></div>';
        }
      }
      if (!any) cells = liveCell(c, sel);
      else if (sel && !progAt(c, S.t)) cells = cells.replace('class="p', 'class="p f'); // focus never disappears into a gap
      html += '<div class="r' + (sel ? ' sel' : '') + '"><div class="ch"><b>' + c.num + '</b><span>' + esc(c.name) + '</span>' +
        (S.favs[c.key] ? '<i class="fav" aria-label="Favorite">★</i>' : '') + '</div><div class="track">' + cells + '</div></div>';
    }
    $('rows').innerHTML = html;

    var nl = $('nowline');
    if (now >= S.winStart && now < S.winStart + WINDOW) { nl.style.left = (304 + x(now)) + 'px'; nl.style.display = 'block'; }
    else nl.style.display = 'none';

    var fc = S.list[S.row], fp = progAt(fc, S.t), extra = [];
    if (fc.place) extra.push(fc.place);
    if (fc.geo) extra.push('may be blocked outside its region');
    if (fc.part) extra.push('not on air all day');
    if (fc.note) extra.push(fc.note);
    if (fp) {
      $('pTitle').textContent = fp[2];
      $('pMeta').textContent = [fc.name, hhmm(fp[0]) + ' to ' + hhmm(fp[1]), fp[4]].concat(extra).filter(Boolean).join(' · ');
      $('pDesc').textContent = fp[3] || (fp[0] > now ? 'Starts at ' + hhmm(fp[0]) + '. Press OK to watch the channel now.' : 'Press OK to watch.');
    } else {
      $('pTitle').textContent = fc.name;
      $('pMeta').textContent = ['Live now', fc.place ? '' : fc.kind, 'no published schedule'].concat(extra).filter(Boolean).join(' · ');
      $('pDesc').textContent = S.guideState === 'loading' ? 'Loading the schedule…' : fc.about || '';
    }
  }

  function tick() {
    var d = new Date();
    $('clock').textContent = d.toDateString().slice(0, 10) + ' · ' + hhmm(d.getTime());
    var nowSlot = Math.floor(Date.now() / SLOT) * SLOT;
    if (S.winStart < nowSlot) S.winStart = nowSlot;
    if (S.t < Date.now()) S.t = Date.now();
    redraw();
    if (S.full && $('banner').className.indexOf('show') >= 0) fillBanner();
  }

  /* ---------- playback ---------- */

  function playState(title, more) {
    var el = $('playState');
    el.innerHTML = title ? esc(title) + (more ? '<small>' + esc(more) + '</small>' : '') : '';
    el.className = 'playState' + (title ? ' show' : '');
  }

  function tune(c, idx) {
    if (!c) return;
    S.tuned = c;
    S.urlIdx = idx || 0;
    store.set('lastKey', c.key);
    clearTimeout(S.stallTimer);
    document.body.classList.add('playing');
    $('previewNote').style.display = 'none';
    playState('Tuning ' + c.name, S.urlIdx ? 'Trying backup stream ' + S.urlIdx : '');
    video.src = c.urls[S.urlIdx];
    var pr = video.play();
    if (pr && pr.catch) pr.catch(function () { /* the error event reports failures */ });
    S.stallTimer = setTimeout(function () { failed('It did not start within 15 seconds.'); }, STALL_MS);
    drawWatching();
  }

  // Try the channel's next stream before giving up.
  function failed(why) {
    clearTimeout(S.stallTimer);
    var c = S.tuned;
    if (c && S.urlIdx + 1 < c.urls.length) return tune(c, S.urlIdx + 1);
    playState((c ? c.name : 'This channel') + ' is not playing',
      why + ' Free streams sometimes go offline. Press CH +/- for the next channel, or Back for the guide.');
  }

  video.addEventListener('playing', function () { clearTimeout(S.stallTimer); playState('', ''); });
  video.addEventListener('waiting', function () {
    clearTimeout(S.stallTimer);
    S.stallTimer = setTimeout(function () { failed('The stream stopped sending video.'); }, STALL_MS);
  });
  video.addEventListener('error', function () { failed('The stream could not be opened.'); });

  function fillBanner() {
    var c = S.tuned;
    if (!c) return;
    var now = Date.now(), p = progAt(c, now), n = p ? progAt(c, p[1]) : null;
    $('bNum').textContent = c.num;
    $('bName').textContent = c.name;
    $('bNow').textContent = p ? 'Now: ' + p[2] + '  (' + hhmm(p[0]) + ' to ' + hhmm(p[1]) + ')' : 'Live now · ' + (c.about || c.kind || '');
    $('bNext').textContent = n ? 'Next at ' + hhmm(n[0]) + ': ' + n[2] : (c.place || '');
    $('bBar').style.width = p ? Math.round((now - p[0]) / (p[1] - p[0]) * 100) + '%' : '0';
  }

  function showBanner() {
    fillBanner();
    var b = $('banner');
    b.className = 'banner show';
    clearTimeout(S.bannerTimer);
    S.bannerTimer = setTimeout(function () { b.className = 'banner'; }, 5000);
  }

  function goFull() {
    if (!S.tuned) return;
    if (!video.src) tune(S.tuned);
    S.full = true;
    setScreen();
    showBanner();
  }

  function leaveFull() {
    S.full = false;
    if (S.screen === 'guide' && S.tuned) {
      for (var i = 0; i < S.list.length; i++) if (S.list[i].key === S.tuned.key) { S.row = i; break; }
      S.t = Date.now();
      resetWindow();
    }
    setScreen();
    redraw();
  }

  function zap(d) {
    var list = S.list.length ? S.list : keysOf(S.tree).map(function (k) { return S.channels[k]; });
    if (!list.length) return;
    var i = 0;
    if (S.tuned) for (var k = 0; k < list.length; k++) if (list[k].key === S.tuned.key) { i = k; break; }
    i = (i + d + list.length) % list.length;
    if (S.list.length) S.row = i;
    tune(list[i]);
    showBanner();
  }

  function toggleFav(c) {
    if (!c) return;
    if (S.favs[c.key]) delete S.favs[c.key]; else S.favs[c.key] = 1;
    store.set('favs2', S.favs);
    notice(S.favs[c.key] ? c.name + ' added to Favorites' : c.name + ' removed from Favorites', 3000);
    redraw();
  }

  /* ---------- settings ---------- */

  function openSettings() {
    var items = [
      { label: 'Online channel list', sub: (S.online || 'Off') + (S.base && S.base === S.online ? '  (in use)' : ''),
        run: function () { askInput('online', 'Online channel list address', 'Where the GitHub job publishes lineup.json. Leave empty to use only your PC.'); } },
      { label: 'PC address (backup)', sub: S.server + (S.base && S.base === S.server ? '  (in use)' : ''),
        run: function () { askInput('server', 'PC address', 'The address tools\\serve-guide.mjs prints on your PC, without the /lineup.json part.'); } },
      { label: 'Channels without a schedule', sub: S.hideEmpty ? 'Hidden' : 'Shown, with a description of what they carry',
        run: function () { S.hideEmpty = !S.hideEmpty; store.set('hideEmpty', S.hideEmpty); closeOverlay(); S.stack = [S.tree]; S.sel = [0]; S.screen = 'home'; setScreen(); redraw(); } },
      { label: 'Reload channels and guide', sub: 'Fetch both again now', run: function () { closeOverlay(); loadLineup(); } }
    ];
    S.overlay = { title: 'Settings', items: items, sel: 0 };
    $('oTitle').textContent = 'Settings';
    $('oInputWrap').className = 'oInput';
    drawOverlay();
    $('overlay').className = 'overlay show';
  }

  function drawOverlay() {
    var o = S.overlay, html = '';
    for (var i = 0; i < o.items.length; i++) {
      var it = o.items[i];
      html += '<li class="' + (i === o.sel ? 'f' : '') + '">' + esc(it.label) + (it.sub ? '<small>' + esc(it.sub) + '</small>' : '') + '</li>';
    }
    $('oList').innerHTML = html;
  }

  function closeOverlay() {
    $('overlay').className = 'overlay';
    $('oInput').blur();
    S.overlay = null;
    redraw();
  }

  function askInput(key, label, help) {
    S.overlay.input = key;
    $('oLabel').textContent = label;
    $('oHelp').textContent = help + ' Press OK on the keyboard to save, Back to cancel.';
    var inp = $('oInput');
    inp.value = S[key] || '';
    $('oInputWrap').className = 'oInput show';
    $('oList').innerHTML = '';
    inp.focus();
  }

  $('oInput').addEventListener('keydown', function (e) {
    var o = S.overlay;
    if (!o || !o.input) return;
    if (e.keyCode === KEY.OK) {
      e.preventDefault(); e.stopPropagation();
      var v = $('oInput').value.trim().replace(/\/+(lineup|guide)\.json.*$/, '').replace(/\/+$/, '');
      S[o.input] = v; store.set(o.input, v);
      closeOverlay();
      loadLineup();
    } else if (e.keyCode === KEY.BACK || e.keyCode === KEY.ESC) {
      e.preventDefault(); e.stopPropagation();
      o.input = null; $('oInput').blur(); $('oInputWrap').className = 'oInput'; drawOverlay();
    }
  });

  /* ---------- keys ---------- */

  function exitApp() {
    if (window.webOS && window.webOS.platformBack) window.webOS.platformBack();
    else if (window.PalmSystem && window.PalmSystem.platformBack) window.PalmSystem.platformBack();
  }

  document.addEventListener('keydown', function (e) {
    var k = e.keyCode, back = k === KEY.BACK || k === KEY.ESC || k === KEY.BKSP;
    if (S.overlay && S.overlay.input) return; // the text field handles its own keys
    var handled = true;

    if (S.overlay) {
      var o = S.overlay;
      if (k === KEY.UP) o.sel = Math.max(0, o.sel - 1);
      else if (k === KEY.DOWN) o.sel = Math.min(o.items.length - 1, o.sel + 1);
      else if (k === KEY.OK) { o.items[o.sel].run(); return e.preventDefault(); }
      else if (back || k === KEY.YELLOW) { closeOverlay(); return e.preventDefault(); }
      else handled = false;
      if (S.overlay) drawOverlay();
    } else if (S.full) {
      if (k === KEY.UP || k === KEY.CH_UP) zap(-1);
      else if (k === KEY.DOWN || k === KEY.CH_DOWN) zap(1);
      else if (k === KEY.OK || k === KEY.INFO || k === KEY.LEFT || k === KEY.RIGHT) showBanner();
      else if (back) leaveFull();
      else if (k === KEY.GREEN) toggleFav(S.tuned);
      else handled = false;
    } else if (S.screen === 'home') {
      var lvl = S.stack.length - 1, n = homeRows().length;
      if (k === KEY.UP) { S.sel[lvl] = Math.max(0, S.sel[lvl] - 1); drawHome(); }
      else if (k === KEY.DOWN) { S.sel[lvl] = Math.min(n - 1, S.sel[lvl] + 1); drawHome(); }
      else if (k === KEY.CH_UP) { S.sel[lvl] = Math.max(0, S.sel[lvl] - HOME_ROWS); drawHome(); }
      else if (k === KEY.CH_DOWN) { S.sel[lvl] = Math.min(n - 1, S.sel[lvl] + HOME_ROWS); drawHome(); }
      else if (k === KEY.OK || k === KEY.RIGHT) homeOK();
      else if (k === KEY.LEFT) { if (S.stack.length > 1) homeBack(); }
      else if (back) homeBack();
      else if (k === KEY.YELLOW || k === KEY.BLUE) openSettings();
      else handled = false;
    } else {
      if (k === KEY.UP) moveRow(-1);
      else if (k === KEY.DOWN) moveRow(1);
      else if (k === KEY.LEFT) moveTime(-1);
      else if (k === KEY.RIGHT) moveTime(1);
      else if (k === KEY.CH_UP) moveRow(-ROWS);
      else if (k === KEY.CH_DOWN) moveRow(ROWS);
      else if (k === KEY.OK) {
        var c = S.list[S.row];
        if (c) { if (!S.tuned || S.tuned.key !== c.key || !video.src) tune(c); goFull(); }
      }
      else if (back || k === KEY.RED) { S.screen = 'home'; setScreen(); drawHome(); }
      else if (k === KEY.GREEN) toggleFav(S.list[S.row]);
      else if (k === KEY.YELLOW || k === KEY.BLUE) openSettings();
      else handled = false;
    }
    if (handled) e.preventDefault();
  });

  /* ---------- start ---------- */

  function fit() {
    // The TV renders at 1920x1080; scaling only matters when testing in a desktop browser.
    var k = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    $('stage').style.transform = k < 0.999 || k > 1.001 ? 'scale(' + k + ')' : '';
  }
  window.addEventListener('resize', fit);
  fit();
  setScreen();
  resetWindow();
  tick();
  setInterval(tick, 30000);
  setInterval(loadGuide, 20 * 60000);
  loadLineup();

  window.__iptv = S; // for debugging from the webOS inspector
})();
