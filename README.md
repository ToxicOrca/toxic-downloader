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
- **Thumbnail preview** — Shows video thumbnails from page metadata (og:image, poster)
- **Trailer detection** — Identifies trailers, previews, and promos by URL patterns, DOM context, and duration analysis

### Downloading
- **HLS stream support** — Downloads m3u8 playlists, fetches all segments, and combines into a single file
- **DASH stream support** — Parses MPD manifests, handles SegmentTemplate/SegmentList/BaseURL, downloads video + audio tracks
- **Direct file download** — Standard mp4, webm, mkv, and other direct video files
- **Quality selector** — Pick your preferred resolution (4K, 1080p, 720p, etc.) before downloading
- **In-browser TS-to-MP4 remuxing** — Converts transport streams to MP4 with no re-encoding or external tools
- **Output format selection** — Choose between MP4 (remuxed) or raw TS in settings
- **Subtitle detection** — Finds and downloads VTT, SRT, and ASS subtitle tracks
- **Batch download** — Download all detected videos on a page with one click

### Smart Naming
- **Intelligent file naming** — Parses JSON-LD, Open Graph tags, headings, breadcrumbs, and URL patterns
- **TV show format** — Automatically names shows as `ShowName_S01E03.mp4`
- **Filename templates** — Customize naming with variables: `{show}`, `{season}`, `{episode}`, `{quality}`, `{title}`, `{type}`

### Download Management
- **Progress tracking** — Real-time progress bar with segment count, file size (MB/GB), and download speed (MB/s)
- **Pause / Resume / Cancel** — Full control over active stream downloads
- **Parallel downloads** — Download multiple videos simultaneously without conflicts
- **Background downloads** — Downloads continue even when the popup is closed
- **Download history** — Persistent log of completed downloads with name, size, date, and type
- **Bandwidth throttle** — Cap download speed to avoid saturating your connection
- **Desktop notifications** — Chrome notifications on download complete or failure

### UI & Usability
- **Dark mode UI** — Clean dark interface with purple/cyan neon accents
- **Side panel mode** — Dock to the right side of your browser, stays open while you browse
- **Auto-scan** — Optionally detect videos automatically when pages load
- **Copy URL** — One-click copy any video URL for use with VLC, ffmpeg, or yt-dlp
- **Export URL list** — Export all detected URLs to a text file
- **Right-click context menu** — "Download with Toxic Downloader" on any video element
- **Settings page** — Full options page for quality, naming, format, throttle, and behavior

---

## Installation

### From Source (Developer Mode)

1. **Clone the repository**
   ```bash
   git clone https://github.com/ToxicOrca/toxic-downloader.git
   ```

2. **Open Chrome** and navigate to `chrome://extensions`

3. **Enable Developer mode** — toggle in the top-right corner

4. **Click "Load unpacked"** and select the `toxic-downloader` folder

5. **Pin the extension** — click the puzzle piece icon in the toolbar and pin Toxic Downloader

> No build step required. The extension runs directly from source.

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
- Check **History** to see past downloads
- **Export** URLs to a text file for use with yt-dlp or ffmpeg

---

## How It Works

### Detection
1. **DOM scanning** — Finds `<video>`, `<source>`, `<track>`, and `<embed>` elements
2. **Network interception** — Hooks `fetch()` and `XMLHttpRequest` to catch video and subtitle URLs as the page's player requests them
3. **Mutation observer** — Watches for dynamically added video elements
4. **Metadata parsing** — Reads JSON-LD, Open Graph tags, headings, breadcrumbs, and URL patterns for titles and season/episode info

### HLS Downloads
1. Fetches the m3u8 master playlist and presents available quality variants
2. Downloads all `.ts` segments in parallel batches (with pause/resume support)
3. Handles AES-128 encrypted streams
4. Remuxes TS to MP4 in-browser or saves as raw TS

### DASH Downloads
1. Parses the MPD XML manifest
2. Selects the best video and audio representations
3. Downloads init segments and media segments
4. Combines into a single output file

### Authentication
Cookies (including HttpOnly) are read via `chrome.cookies` API and injected into CDN requests using `declarativeNetRequest` session rules — each download gets its own isolated rule set.

---

## Tech Stack

- **Manifest V3** Chrome Extension
- **Vanilla JavaScript** — zero dependencies, no build step
- **Chrome APIs** — Side Panel, Downloads, Cookies, DeclarativeNetRequest, Notifications, Context Menus, Storage
- **Custom TS-to-MP4 remuxer** — Demuxes MPEG-TS and muxes H.264/AAC into fragmented MP4

---

## Project Structure

```
toxic-downloader/
├── manifest.json          # Extension manifest (MV3)
├── background.js          # Service worker — orchestration, downloads, auth
├── content.js             # Content script — detection, parsing, coordination
├── interceptor.js         # Page-context — XHR/fetch interception
├── hls-downloader.js      # Page-context — cookie extraction
├── remux.js               # TS-to-MP4 remuxer
├── popup.html/css/js      # Popup UI
├── sidepanel.html         # Side panel UI
├── options.html/css/js    # Settings page
└── icons/                 # Extension icons
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
