# couchcast

> Type one command in a folder and watch its videos from the couch.

`couchcast` turns any folder into a DLNA / UPnP AV media server. VLC (iPhone, iPad, macOS, Android) and smart TVs (Samsung, LG, Sony, Philips) discover it on the local network, browse it, and play videos with seeking. No library database, no transcoding, and no config.

```sh
cd ~/Movies
npx couchcast
```

```
╭──────────────────────────────────────────────────────────────╮
│ couchcast on MacBook-Air                                     │
│ Serving  ~/Movies · 42 videos                                │
│ URL      http://192.168.1.26:8200/description.xml            │
│ Network  en0 (192.168.1.26)                                  │
│ Sleep    ● awake (caffeinate)                                │
╰──────────────────────────────────────────────────────────────╯
 Clients (1)
   192.168.1.40     VLC             3s ago   VLC/3.0.21 LibVLC/3.0.21
 Streams (1)
   Big Buck Bunny   VLC             ██████░░░░░░░░░░   38%    4.1 MB/s   1.2 GB
 Log
 21:04:11 [server] ▶ VLC playing "Big Buck Bunny"
 q quit  v verbose off  r rescan
```

## Install

Requires Node.js 22.12 or newer.

```sh
npx couchcast            # run once
npm i -g couchcast       # or install it
```

Nothing else is needed. couchcast has built-in readers that get the duration, resolution and codecs from **MP4, MOV, M4V, 3GP, MKV and WebM** files. Some TVs only show a seek bar when they know the duration.

Optional: if [ffprobe](https://ffmpeg.org) is installed (`brew install ffmpeg`, `apt install ffmpeg`), couchcast uses it instead, which also covers AVI, TS, MPEG, WMV and FLV. Files that neither can read are still served; couchcast guesses their MIME type from the extension.

## Usage

```
couchcast [serve] [options]

  -d, --dir <path>          Folder to serve (default: current directory)
  -n, --name <name>         Server name shown on clients (default: "couchcast on <hostname>")
  -p, --port <port>         HTTP port (default: 8200, falls back to a free port)
  -i, --interface <if|ip>   Network interface or IPv4 address (default: auto)
      --no-ui               Plain log output instead of the dashboard
      --no-keep-awake       Let the computer sleep while streaming
      --grace <seconds>     Stay awake this long after the last stream ends (default: 120)
      --no-ffprobe          Skip ffprobe even if installed (built-in readers still run)
      --no-watch            Don't watch the folder for changes
  -v, --verbose             Debug logs
```

Dashboard keys: `q` quits, `v` toggles verbose logs, `r` rescans the folder.

When stdout is not a TTY (piping, systemd, Docker), couchcast switches to `--no-ui` on its own.

### Watching on…

| Client | Where to find it |
|---|---|
| VLC (iOS / Android) | Network → Local Network → *couchcast on …* |
| VLC (macOS) | Sidebar → Local Network → Universal Plug'n'Play |
| Samsung (Tizen) | Source / Connected Devices |
| LG (webOS) | Media Player / Photo & Video → server list |
| Sony / Philips (Android TV) | Media / Video app, DLNA servers |

### What gets served

- Videos: `mp4 m4v mkv mov avi webm ts m2ts mts mpg mpeg vob wmv asf flv 3gp ogv`
- Subfolders become folders on the TV. Folders with no videos are hidden.
- Hidden files and folders (names starting with `.`) are skipped.
- `Movie.srt` next to `Movie.mkv` is offered as a subtitle, including Samsung's `CaptionInfo.sec` mechanism.
- New, removed or renamed files show up within a couple of seconds. couchcast bumps `SystemUpdateID` so clients refresh.

## Troubleshooting

- **The server doesn't show up.** On macOS 15+, the first run triggers a "Local Network" permission prompt for your terminal app. Allow it, or enable it later in System Settings → Privacy & Security → Local Network. Also check that your phone or TV is on the same network and not on a guest Wi-Fi. If you use a VPN, pass `-i en0`.
- **Firewall.** Allow incoming connections for `node`, or open UDP 1900 and the HTTP port (8200 by default).
- **No seek bar on the TV.** The TV probably doesn't know the duration. That happens for formats the built-in readers don't cover (AVI, TS, …) and for fragmented MP4s. Install ffmpeg/ffprobe.
- **Run `couchcast -v`** to see every SSDP search, SOAP call and byte range.

## How it works

```
bin/couchcast.js          CLI (parseArgs) → commands/serve.js
src/server.js             wires everything, emits state for the UI
src/ssdp/                 discovery: NOTIFY alive/byebye, M-SEARCH responses (raw node:dgram)
src/upnp/                 device description, SCPD, SOAP, GENA eventing, DIDL-Lite
src/library/              folder scan → containers/items with stable IDs, fs.watch
src/probe/                built-in MP4/MKV readers, optional ffprobe → MIME + DLNA protocolInfo
src/stream/               Range/206/416 file streaming with DLNA headers + session tracking
src/keep-awake.js         caffeinate / systemd-inhibit, reference-counted by active streams
src/quirks.js             per-client tweaks matched on User-Agent
src/ui/                   Ink dashboard written with htm (no JSX, no build step)
```

Design notes:

- **Stable identity.** The device UUID lives in a small state file in your config directory (`~/Library/Application Support/couchcast` or `$XDG_CONFIG_HOME/couchcast`), so TVs don't list a new server every run. Object IDs are hashes of relative paths, so they survive rescans and restarts.
- **Byte seeking only.** couchcast advertises `DLNA.ORG_OP=01` (Range requests, no TimeSeekRange) and never transcodes. If a TV can't decode a file, couchcast can't fix that.
- **Bounded work.** Files are streamed with `stream.pipeline`, with backpressure and cleanup on disconnect. Metadata probing reads only box/element headers (plus `moov`, or the MKV Info and Tracks sections), detects the format from magic bytes, runs with limited concurrency, and is cached by path, mtime and size.
- **Clean shutdown.** couchcast sends `ssdp:byebye`, closes connections and stops the keep-awake helper. The helper (`caffeinate -w <pid>`) also exits on its own if couchcast crashes.

## Roadmap

- [x] Scaffold, CI, tests
- [x] SSDP + device description (discoverable in VLC)
- [x] ContentDirectory Browse + HTTP streaming with Range
- [x] Ink dashboard + keep-awake
- [x] ffprobe-based metadata, subtitles, first Samsung/LG quirks
- [ ] Field-tested quirk table for Samsung, LG, Sony and Philips (reports welcome: run with `-v` and open an issue)
- [ ] DLNA profile names (`DLNA.ORG_PN`) for common H.264/AAC MP4s
- [ ] Thumbnails (`upnp:albumArtURI`) via ffmpeg
- [ ] `couchcast play <file> --to <tv>`: push to a renderer (AVTransport control point)
- [ ] Optional HTTP basic auth / IP allow list

**Non-goals for now:** Google Cast, AirPlay, web UI, music and photos, transcoding, a metadata database.

## Development

```sh
npm install
npm run check        # eslint (neostandard) + tsc --checkJs + node:test
npm start -- -v      # run from source
```

Plain ESM JavaScript with JSDoc types. There is no build step. Lint uses [neostandard](https://github.com/neostandard/neostandard), which handles both linting and formatting with one tool and no config to argue about.

Behavior references: ReadyMedia/minidlna, Gerbera, Rygel, Universal Media Server, and the UPnP AV / DLNA specs. couchcast contains no code from them.

## License

MIT © Rocco Musolino
