# Changelog

## 0.1.0 (unreleased)

- DLNA MediaServer:1 with ContentDirectory and ConnectionManager.
- SSDP discovery with stable device UUID, periodic re-announce and byebye on exit.
- Range/206/416 streaming with DLNA headers, sidecar `.srt` subtitles (incl. Samsung `CaptionInfo.sec`).
- Built-in MP4/MOV and MKV/WebM metadata readers (duration, resolution, codecs); optional ffprobe for other formats.
- Ink dashboard (clients, streams, logs), `--no-ui` plain logs.
- Keep-awake while streaming via `caffeinate` (macOS) / `systemd-inhibit` (Linux).
