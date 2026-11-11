/* Search over the guide: show titles, channel names, and the details in each listing
   (team names for games). Matches word beginnings ("cin", "dan"), initials ("dwts"),
   and small typos ("dtws", "cinncinatti"). ES5 for the webOS 4 engine.

   IPTVSearch.build(channels, progsFor) indexes the guide once it loads;
   IPTVSearch.query(text) returns ranked results. */
(function () {
  'use strict';

  var STOP = { the: 1, a: 1, an: 1, of: 1, and: 1, on: 1, in: 1, at: 1, to: 1, with: 1 };
  var idx = null;

  function norm(s) {
    s = String(s || '').toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function words(s) { var n = norm(s); return n ? n.split(' ') : []; }
  function initials(ws) { return ws.map(function (w) { return w.charAt(0); }).join(''); }

  // Edit distance with swapped neighbours counting as one edit ("dtws" vs "dwts").
  function distance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var d = [], i, j;
    for (i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (j = 0; j <= b.length; j++) { d[0][j] = j; }
    for (i = 1; i <= a.length; i++) {
      var rowMin = max + 1;
      for (j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        if (d[i][j] < rowMin) rowMin = d[i][j];
      }
      if (rowMin > max) return max + 1;
    }
    return d[a.length][b.length];
  }

  // One entry per show per channel (airings grouped) and one per channel.
  function build(channels, progsFor) {
    var now = Date.now(), entries = [], byId = {}, vocab = {};
    function post(w, e, field) {
      if (!w) return;
      var list = vocab[w] || (vocab[w] = []);
      if (!list.length || list[list.length - 1][0] !== e) list.push([e, field]);
    }
    for (var key in channels) {
      var c = channels[key];
      var cw = words(c.name);
      var ce = entries.length;
      entries.push({ type: 'channel', key: key, title: c.name, acr: initials(cw), acr2: initials(cw.filter(function (w) { return !STOP[w]; })) });
      cw.forEach(function (w) { post(w, ce, 2); });
      var progs = progsFor(c) || [];
      for (var i = 0; i < progs.length; i++) {
        var p = progs[i];
        if (p[1] <= now || !p[2]) continue;
        var id = key + '|' + p[2];
        var e = byId[id];
        if (e === undefined) {
          var tw = words(p[2]);
          e = byId[id] = entries.length;
          entries.push({ type: 'show', key: key, title: p[2], airs: [], acr: initials(tw), acr2: initials(tw.filter(function (w) { return !STOP[w]; })),
            sport: /\bvs?\b|\bat\b.*\b(game|football|basketball)|football|basketball|baseball|hockey|soccer|\bnfl\b|\bnba\b|\bncaa/i.test(p[2] + ' ' + p[3] + ' ' + p[4]) });
          tw.forEach(function (w) { post(w, e, 0); });
          words(p[3] + ' ' + p[4]).forEach(function (w) { if (!STOP[w] && w.length > 1) post(w, e, 1); });
          cw.forEach(function (w) { post(w, e, 3); });
        }
        entries[e].airs.push(p);
      }
    }
    idx = { entries: entries, vocab: vocab, words: Object.keys(vocab).sort() };
    return entries.length;
  }

  // Index words that start with the token, found by binary search in the sorted list.
  function prefixWords(t) {
    var ws = idx.words, lo = 0, hi = ws.length, out = [];
    while (lo < hi) { var mid = (lo + hi) >> 1; if (ws[mid] < t) lo = mid + 1; else hi = mid; }
    for (var i = lo; i < ws.length && ws[i].lastIndexOf(t, 0) === 0 && out.length < 400; i++) out.push(ws[i]);
    return out;
  }

  // Words close to the token, for typos. Only words with the same first letter are tried.
  function fuzzyWords(t) {
    var max = t.length >= 8 ? 2 : 1, out = [], ws = idx.words;
    var i = 0, lo = 0, hi = ws.length, first = t.charAt(0);
    while (lo < hi) { var mid = (lo + hi) >> 1; if (ws[mid] < first) lo = mid + 1; else hi = mid; }
    for (i = lo; i < ws.length && ws[i].charAt(0) === first; i++) {
      var w = ws[i];
      if (w.length < t.length - max) continue;
      if (distance(t, w.slice(0, t.length), max) <= max || distance(t, w, max) <= max) out.push(w);
    }
    return out;
  }

  // Field weights: title word, listing detail (teams, episode), channel name.
  var WEIGHT = [3, 1, 2, 0.5];

  function query(text) {
    if (!idx) return [];
    var q = norm(text);
    if (!q) return [];
    var tokens = q.split(' '), scores = {}, i, j;

    for (i = 0; i < tokens.length; i++) {
      var t = tokens[i], hit = {};
      var exact = prefixWords(t), fuzzy = t.length >= 4 ? fuzzyWords(t) : [];
      var add = function (ws, factor) {
        for (var a = 0; a < ws.length; a++) {
          var posts = idx.vocab[ws[a]];
          for (var b = 0; b < posts.length; b++) {
            var e = posts[b][0], f = posts[b][1];
            if (f === 1 && t.length < 3) continue; // listing details need at least 3 letters
            var s = WEIGHT[f] * factor * (ws[a] === t ? 1.2 : 1);
            if (!hit[e] || hit[e] < s) hit[e] = s;
          }
        }
      };
      add(exact, 1);
      add(fuzzy, 0.6);
      if (i === 0) { for (var k in hit) scores[k] = hit[k]; }
      else { for (var k2 in scores) { if (hit[k2]) scores[k2] += hit[k2]; else delete scores[k2]; } }
    }

    // Initials: "dwts" for Dancing with the Stars, "snl", "wwe". One word only.
    if (tokens.length === 1 && q.length >= 2) {
      for (j = 0; j < idx.entries.length; j++) {
        var en = idx.entries[j], s2 = 0;
        if (en.acr.length < 2) continue;
        if (en.acr === q || en.acr2 === q) s2 = 5;
        else if (q.length >= 3 && (en.acr.lastIndexOf(q, 0) === 0 || en.acr2.lastIndexOf(q, 0) === 0)) s2 = 3;
        // A typo in initials only counts against initials of the same length ("dtws" for "dwts").
        else if (q.length >= 4 && ((en.acr.length === q.length && distance(q, en.acr, 1) <= 1) ||
          (en.acr2.length === q.length && distance(q, en.acr2, 1) <= 1))) s2 = 3;
        if (s2) scores[j] = Math.max(scores[j] || 0, s2);
      }
    }

    var now = Date.now(), out = [];
    for (var id in scores) {
      var en2 = idx.entries[id], sc = scores[id], next = null;
      if (en2.type === 'show') {
        for (j = 0; j < en2.airs.length; j++) if (en2.airs[j][1] > now) { next = en2.airs[j]; break; }
        if (!next) continue;
        if (next[0] <= now) sc += 1.5;                    // on now
        else if (next[0] - now < 3 * 3600e3) sc += 0.5;  // within three hours
        if (en2.sport) sc += 0.5;
      } else sc += 0.5;
      if (norm(en2.title).lastIndexOf(q, 0) === 0) sc += 2;
      out.push({ type: en2.type, key: en2.key, title: en2.title, air: next, score: sc });
    }
    out.sort(function (a, b) { return b.score - a.score || (a.air && b.air ? a.air[0] - b.air[0] : 0); });

    // The same show on many channels: keep the best few airings.
    var seen = {}, final = [];
    for (j = 0; j < out.length && final.length < 40; j++) {
      var r = out[j], n = (seen[r.title] = (seen[r.title] || 0) + 1);
      if (r.type === 'show' && n > 3) continue;
      final.push(r);
    }
    return final;
  }

  window.IPTVSearch = { build: build, query: query, norm: norm };
})();
