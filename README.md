# IPTV Guide for LG webOS

A TV app for the free US channels listed by [iptv-org](https://github.com/iptv-org/iptv), sorted into folders, with a programme guide built for those channels. Tested on an LG 50UK6090PUA (webOS 4.4, firmware 05.50.70).

## What's here

| Path | What it is |
| --- | --- |
| `app/` | The TV app. Plain HTML, CSS and ES5 JavaScript, because webOS 4 runs a Chrome 53 engine. |
| `tools/build-lineup.mjs` | Builds the US channel lineup (`guide/lineup.json`) and its schedules (`guide/guide.json`). |
| `tools/classify.mjs` | The folder rules: which channel goes in Sports › Football, Local News › Ohio › Cleveland, and so on. |
| `tools/serve-guide.mjs` | Serves the lineup and guide to the TV over your home network. |
| `start-guide.cmd` | Runs the builder, then the server. Double-click it. |
| `dist/` | The packaged app (`.ipk`). |

## Every day

1. Double-click `start-guide.cmd` on the PC and leave the window open. The first build takes a few minutes because it tests every stream; rebuilds within two hours are quicker.
2. Open **IPTV Guide** on the TV.

The guide covers two days. Run `start-guide.cmd` again at least every other day.

If the PC is off, the app still opens, but it falls back to iptv-org's plain US playlist without folders or schedules.

## Which channels are in

- Channels iptv-org lists as American, on a feed broadcast in the US, in English or Spanish.
- Not included: international editions (CNN International and similar), foreign-language channels, closed channels, and streams that need special headers.
- Every stream is test-opened during the build. Channels with no working stream are left out, and channels with several streams keep them all, so the app moves to the next one if a stream fails.

## Folders

Sports (Football and Basketball first), National News (Top Networks, Business & Finance, Weather, More News), Local News by state and city, Movies, TV Shows, Kids & Family, Music, Documentary & Science, Lifestyle, En Español, Religious, Community & Government, and More Channels. Change the rules in `tools/classify.mjs` and run `start-guide.cmd` again.

## Where the schedules come from

1. iptv-org's guide index, for sources readable without their grabber: i.mjh.nz XMLTV files (Pluto, Plex, Roku, Samsung TV Plus) and tvpassport.com station pages.
2. Pluto TV channels, matched by the id in their stream address.
3. Local stations, matched to tvpassport.com by call sign.
4. Network affiliates with no schedule of their own get the network's schedule from another station in their time zone. The guide says so, since local news times can differ.
5. Channels that publish no schedule anywhere show "Live now" and a line about what they carry. Settings (Yellow) can hide them.

## Remote

| Button | Folders | Guide | Watching |
| --- | --- | --- | --- |
| Up/Down | Move | Move between channels | Change channel |
| OK or Right | Open | Watch | Show what's on |
| Back | Up a folder (exits at the top) | Back to folders | Back to where you were |
| Left/Right | | Earlier or later programmes | Show what's on |
| CH +/- | Page | Page through channels | Change channel |
| Green | | Add or remove a favorite | Add or remove a favorite |
| Yellow | Settings | Settings | |

## Putting the app first on the home bar

Developer Mode doesn't let apps change the home bar order, so do this once on the TV:

1. Press **Home**.
2. Move to **IPTV Guide** in the bar along the bottom.
3. Press **Up** on it (or hold **OK**) to enter edit mode.
4. Press **Left** until it sits first, then **OK**.

## Reinstalling the app

Developer Mode switches off after about 50 hours unless you press **Extend** in the Developer Mode app, and the app is removed when it runs out. To put it back:

```bash
ares-install.cmd -d lgtv dist\com.home.iptvguide_1.1.0_all.ipk
```

After changing anything in `app/`, package it again first with `ares-package.cmd app -o dist`.

## Known limits

- Free streams come and go. Live NFL and NBA games aren't on free legal streams, so Football and Basketball hold NFL Channel, NFL Network and NBA TV (shows, highlights and replays).
- Local News only covers stations that stream for free; iptv-org has none for Columbus right now.
- If the PC's address changes, update it under Settings (Yellow) › PC address.
