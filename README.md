# Toxic Downloader

**Grab the video. Keep it local. No drama.**

A Chrome extension for capturing and downloading web video streams you have legitimate access to — built with Manifest V3, vanilla JS, and zero dependencies.

![Chrome](https://img.shields.io/badge/Chrome-Manifest%20V3-green)
![License](https://img.shields.io/badge/License-MIT-blue)
![Dependencies](https://img.shields.io/badge/Dependencies-None-brightgreen)

<p align="center">
  <img src="icons/icon128.png" alt="Toxic Downloader" width="128"/>
</p>

---

## Features

### Video Detection
- **Smart source detection** — Scans the DOM and intercepts XHR/fetch requests to find video streams automatically
- **Mutation observer** — Watches for dynamically loaded video elements
- **Thumbnail preview** — Shows video thumbnails from page metadata when available
- **Trailer detection** — Identifies trailers, previews, and promos by URL patterns, DOM context, and duration

### Downloading
- **HLS stream support** — Downloads m3u8 playlists, fetches all segments, and combines them
- **DASH stream support** — Parses MPD manifests, downloads video + audio tracks
- **Direct file download** — Standard mp4, webm, mkv, and other direct video files
- **Quality selector** — Pick your preferred resolution before downloading (when the stream offers multiple qualities)
- **Batch download** — Download all detected videos on a page with one click

### Remuxing & Subtitles
- **Built-in TS-to-MP4 remuxer** — Converts transport streams to MP4 in-browser for smaller files
- **System FFmpeg integration** — For large files, uses your local FFmpeg install via native messaging to remux TS → MP4 with embedded subtitles, no file size limit
- **Subtitle detection** — Finds VTT, SRT, and ASS subtitle tracks on the page
- **VTT-to-SRT conversion** — Converts WebVTT to SRT for better compatibility with media servers
- **Subtitle embedding** — Embeds subtitles directly into MP4 files (via System FFmpeg)
- **Auto-download subtitles** — Optionally downloads detected subtitle tracks alongside videos
- **Jellyfin/Plex naming** — Subtitle files use `VideoName.lang.srt` format for automatic detection

### Smart Naming
- **Intelligent file naming** — Parses JSON-LD, Open Graph tags, headings, breadcrumbs, and URL patterns
- **TV show format** — Automatically names shows as `ShowName_S01E03_Episode_Title.mp4`
- **Site name stripping** — Dynamically detects and removes the streaming site's brand name from titles
- **Filename templates** — Customize naming with variables: `{show}`, `{season}`, `{episode}`, `{episode_name}`, `{quality}`, `{title}`, `{type}`

### Download Management
- **Progress tracking** — Real-time progress bar with segment count, file size (MB/GB), and download speed (MB/s)
- **Pause / Resume / Cancel** — Full control over active stream downloads
- **Parallel downloads** — Download multiple videos simultaneously
- **Background downloads** — Downloads continue even when the popup is closed
- **Active Downloads panel** — Shows all ongoing downloads across all tabs at the top of the UI
- **Download history** — Persistent log with search, individual deletion, and clear all
- **Bandwidth throttle** — Cap download speed to avoid saturating your connection
- **Desktop notifications** — Chrome notifications on download complete or failure
- **Activity log** — Detailed diagnostic log for troubleshooting download and remux issues

### UI & Usability
- **Dark mode UI** — Clean dark interface with purple/cyan neon accents
- **Side panel mode** — Dock to the right side of your browser, stays open while you browse
- **Auto-scan** — Optionally detect videos automatically when pages load
- **Copy URL** — One-click copy any video URL for use with VLC, ffmpeg, or yt-dlp
- **Export URL list** — Export all detected URLs to a text file
- **Right-click context menu** — "Download with Toxic Downloader" on any video element
- **Settings page** — Full options for quality, naming, format, remux engine, throttle, and behavior

---

## Installation

### Quick Install (Download ZIP)

1. Go to the [latest release](https://github.com/ToxicOrca/toxic-downloader/releases/latest)
2. Download `toxic-downloader.zip`
3. **Extract the ZIP** to a folder on your computer
4. Open Chrome and navigate to `chrome://extensions`
5. Enable **Developer mode** — toggle in the top-right corner
6. Click **Load unpacked** and select the extracted folder
7. **Pin the extension** — click the puzzle piece icon in the toolbar and pin Toxic Downloader

### From Source

```bash
git clone https://github.com/ToxicOrca/toxic-downloader.git
```

Then follow steps 4–7 above.

> No build step required. The extension runs directly from source.

### System FFmpeg Setup (Optional)

For large file remuxing and subtitle embedding, install the native FFmpeg host:

**Prerequisites:**
- [Python 3](https://python.org) installed and in PATH
- [FFmpeg](https://ffmpeg.org/download.html) installed and in PATH

**Windows:**
```
cd native-host
install_windows.bat
```

**Linux / Mac:**
```
cd native-host
chmod +x install_linux_mac.sh
./install_linux_mac.sh
```

The installer will:
1. Ask for your extension ID (found at `chrome://extensions`)
2. Create a native messaging manifest
3. Register it with Chrome

Then select **"System FFmpeg"** in Toxic Downloader settings under Remux Engine.

---

## Usage

### Quick Mode (Popup)
1. Navigate to a page with video content
2. Click the Toxic Downloader icon in your toolbar
3. Click **Scan** to detect videos
4. Pick a quality if prompted, then click the **download button**

### Docked Mode (Side Panel)
1. Open the popup and click the **dock icon** (panel icon next to Scan)
2. The extension docks to the right side of your browser and stays open
3. It auto-refreshes when you switch tabs or navigate to new pages

### Batch Download
- Click **Download All** in the footer to download every detected non-trailer video at once

### Tips
- Streams (m3u8/mpd) are downloaded as segments and combined automatically
- Use **Copy URL** to grab the direct stream URL for external tools
- Trailers are automatically dimmed and sorted to the bottom
- **Pause** long downloads and resume them later
- Check **History** → **Activity Log** for detailed diagnostic info if something goes wrong
- **Export** URLs to a text file for use with yt-dlp or ffmpeg
- With System FFmpeg enabled, downloads are automatically remuxed to MP4 with embedded subtitles

---

## How It Works

### Detection
1. **DOM scanning** — Finds `<video>`, `<source>`, `<track>`, and `<embed>` elements
2. **Network interception** — Hooks `fetch()` and `XMLHttpRequest` to catch video and subtitle URLs
3. **Mutation observer** — Watches for dynamically added video elements
4. **Metadata parsing** — Reads JSON-LD, Open Graph tags, headings, breadcrumbs, and URL patterns

### Stream Downloads
1. Fetches the m3u8/mpd playlist and presents available quality variants
2. Downloads all segments in parallel batches (with pause/resume support)
3. Handles AES-128 encrypted HLS streams
4. Saves as MP4 (remuxed) or TS depending on settings

### Remux Pipeline
- **Built-in** — JavaScript TS demuxer + MP4 muxer for files under ~300MB
- **System FFmpeg** — For any file size: saves .ts first, then calls FFmpeg via native messaging to remux to MP4 with `mov_text` subtitles and `faststart` flag

### Authentication
Cookies (including HttpOnly) are read via `chrome.cookies` API and injected into CDN requests using `declarativeNetRequest` session rules — each download gets its own isolated rule set.

---

## Tech Stack

- **Manifest V3** Chrome Extension
- **Vanilla JavaScript** — zero dependencies, no build step
- **Chrome APIs** — Side Panel, Downloads, Cookies, DeclarativeNetRequest, Notifications, Context Menus, Storage, Native Messaging, Alarms
- **Custom TS-to-MP4 remuxer** — Demuxes MPEG-TS and muxes H.264/AAC into fragmented MP4
- **Native FFmpeg host** — Python native messaging bridge for system FFmpeg integration

---

## Project Structure

```
toxic-downloader/
├── manifest.json          # Extension manifest (MV3)
├── background.js          # Service worker — orchestration, downloads, auth
├── content.js             # Content script — detection, parsing, coordination
├── interceptor.js         # Page-context — XHR/fetch interception
├── hls-downloader.js      # Page-context — cookie extraction
├── remux.js               # Built-in TS-to-MP4 remuxer
├── subtitle-embed.js      # MP4 subtitle track embedder
├── popup.html/css/js      # Popup UI
├── sidepanel.html         # Side panel UI
├── options.html/css/js    # Settings page
├── icons/                 # Extension icons
└── native-host/           # System FFmpeg integration
    ├── toxic_ffmpeg_host.py    # Native messaging host
    ├── toxic_ffmpeg_host.bat   # Windows launcher
    ├── install_windows.bat     # Windows installer
    └── install_linux_mac.sh    # Linux/Mac installer
```

---

## Legal Disclaimer

> **Toxic Downloader is a personal media utility. It is your responsibility to ensure you have the right to download any content you capture with this tool.**

This extension is intended for lawful personal use cases, including but not limited to:

- Downloading videos **you uploaded yourself** from platforms that make direct download inconvenient
- Archiving **Creative Commons** or **public domain** videos for offline use
- Saving **educational or instructional content** from platforms you have paid or legitimate access to
- Capturing streams from your **own self-hosted or organization-internal** media servers

**Do not use this extension to download copyrighted content without the rights holder's permission.** Doing so may violate copyright law (including the DMCA in the United States and equivalent legislation in other jurisdictions), platform terms of service, and/or content licensing agreements.

The authors and contributors of this project are not responsible for how you use it. This software is provided as-is, without warranty of any kind. By using it, you accept full legal responsibility for your own actions.

---

## Contributing

Contributions are welcome! Please open an issue before submitting a pull request for significant changes.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Commit your changes with clear messages
4. Open a pull request against `main`

---

## License

[MIT](LICENSE)
