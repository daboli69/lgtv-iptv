# IPTV Guide for LG webOS

A TV app for the free US channels listed by [iptv-org](https://github.com/iptv-org/iptv), sorted into folders, with a programme guide built for those channels. Tested on an LG 50UK6090PUA (webOS 4.4, firmware 05.50.70).

## What's here

| Path | What it is |
| --- | --- |
| `app/` | The TV app. Plain HTML, CSS and ES5 JavaScript, because webOS 4 runs a Chrome 53 engine. |
| `tools/build-lineup.mjs` | Builds the US channel lineup (`guide/lineup.json`) and its schedules (`guide/guide.json`). |
| `tools/classify.mjs` | The folder rules: which channel goes in Sports › Football, Local News › Ohio › Cleveland, and so on. |
| `tools/serve-guide.mjs` | Serves the lineup and guide from your PC, as a backup to the online copy. |
| `.github/workflows/build-guide.yml` | Rebuilds the lineup and guide every 3 hours and publishes them on GitHub Pages. |
| `start-guide.cmd` | Builds and serves from your PC. Only needed if the online copy is down. |
| `dist/` | The packaged app (`.ipk`, not in git). |

## Every day

Open **IPTV Guide** on the TV. Nothing needs to run at home.

A GitHub Actions job rebuilds the channel list and guide every 3 hours and publishes them at <https://daboli69.github.io/lgtv-iptv/>. The TV reads `lineup.json` and `guide-window.json` from there (the next 15 hours of schedules).

The app looks in three places, in order:

1. The online copy on GitHub Pages.
2. Your PC, if `start-guide.cmd` is running (Settings › PC address).
3. iptv-org's plain US playlist, without folders, so there is always something to watch.

To rebuild right away, open the repo's **Actions** tab, pick **Build lineup and guide** and press **Run workflow**, or run `gh workflow run build-guide.yml -R daboli69/lgtv-iptv`. GitHub pauses scheduled jobs in repos with no activity for 60 days; the Actions tab shows a button to turn it back on.

## Which channels are in

- Channels iptv-org lists as American, on a feed broadcast in the US, in English or Spanish.
- Not included: international editions (CNN International and similar), foreign-language channels, closed channels, and streams that need special headers.
- Every stream is test-opened during the build. Channels with no working stream are left out, and channels with several streams keep them all, so the app moves to the next one if a stream fails.

## Folders

Sports (Football and Basketball first), National News (Top Networks, Business & Finance, Weather, More News), Local News by state and city, Movies, TV Shows, Kids & Family, Music, Documentary & Science, Lifestyle, En Español, Religious, Community & Government, and More Channels. Change the rules in `tools/classify.mjs` and push; the job rebuilds on every push to `tools/`.

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
| Blue | Search | Search | Search |
| Yellow | Settings | Settings | |

## Search

Press **Blue**, or pick **Search** at the top of the home screen, and start typing. Results update as you type, with shows on now listed first.

- Word beginnings work: `dan`, `cin`, `price is`.
- Initials work: `snl`, `dwts`.
- Small typos are forgiven: `jepardy`, `dtws`.
- Games are found by team name, since the guide lists the teams in each game's details.

Press **Down** to move into the results and **OK** to pick one. A show on now, or a channel, starts playing; a show later today opens the guide at its start time. **Back** returns to your results. Search covers what the guide holds: the next 15 hours.

## Putting the app first on the home bar

Developer Mode doesn't let apps change the home bar order, so do this once on the TV:

1. Press **Home**.
2. Move to **IPTV Guide** in the bar along the bottom.
3. Press **Up** on it (or hold **OK**) to enter edit mode.
4. Press **Left** until it sits first, then **OK**.

## Reinstalling the app

Developer Mode switches off after about 50 hours unless you press **Extend** in the Developer Mode app, and the app is removed when it runs out. To put it back:

```bash
ares-install.cmd -d lgtv dist\com.home.iptvguide_1.4.0_all.ipk
```

After changing anything in `app/`, package it again first with `ares-package.cmd app -o dist`.

## Known limits

- Free streams come and go. Live NFL and NBA games aren't on free legal streams, so Football and Basketball hold NFL Channel, NFL Network and NBA TV (shows, highlights and replays).
- Local News only covers stations that stream for free; iptv-org has none for Columbus right now.
- The online build runs from GitHub's servers, so a few streams that block data centres may be left out there even though they play at home. The PC build tests from your own connection.
- The Barlow fonts in `app/fonts` are under the SIL Open Font License.
