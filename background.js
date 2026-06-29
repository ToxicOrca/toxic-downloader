// Toxic Downloader - Background Service Worker

const videoStore = {};
const downloadProgress = {};
const hlsDownloadTabs = {};
const activeDownloads = {}; // videoUrl -> dlId
const activeDownloadNames = {}; // dlId -> filename
let nextRuleBase = Math.floor(Math.random() * 900000) + 100000; // Random start to avoid collisions on SW restart

// Clear stale session rules from previous SW lifecycle on startup
try { chrome.declarativeNetRequest.getSessionRules((rules) => {
  if (rules.length > 0) {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map(r => r.id) });
  }
}); } catch (_) {}
const subtitleStore = {}; // tabId -> [{url, lang, label}]

// --- Settings defaults ---
const DEFAULTS = {
  defaultQuality: "best",
  filenameTemplate: "",
  maxConcurrent: 3,
  outputFormat: "mp4",
  autoScan: false,
  notifications: true,
  subtitleAutoDownload: false,
  convertVttToSrt: false,
  embedSubtitles: false,
  remuxEngine: "builtin",
  ffmpegPath: "ffmpeg",
  bandwidthLimit: 0, // 0 = unlimited, otherwise bytes/sec
};

// --- Download Queue & Pause/Resume ---
const pausedDownloads = {}; // dlId -> true
const cancelledDownloads = {}; // dlId -> true
const downloadSegmentState = {}; // dlId -> { completedSegments, totalSegments, segmentUrls, ... }

async function getSettings() {
  try { return await chrome.storage.sync.get(DEFAULTS); }
  catch (_) { return { ...DEFAULTS }; }
}

// --- Service Worker Keep-Alive ---
// Chrome kills idle service workers after 30s. Keep alive while downloads are active/paused.
let keepAliveInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  // Create an alarm that fires every 25s to keep the SW alive
  chrome.alarms.create("toxic-keepalive", { periodInMinutes: 0.4 });
  keepAliveInterval = true;
}

function stopKeepAliveIfIdle() {
  const hasActive = Object.keys(activeDownloads).length > 0 || Object.keys(pausedDownloads).length > 0;
  if (!hasActive && keepAliveInterval) {
    chrome.alarms.clear("toxic-keepalive");
    keepAliveInterval = null;
  }
}

// --- Activity Log ---
const activityLog = []; // {time, message}
const MAX_LOG = 100;

function log(msg) {
  activityLog.push({ time: Date.now(), message: msg });
  if (activityLog.length > MAX_LOG) activityLog.shift();
  try { chrome.storage.local.set({ activityLog }); } catch (_) {}
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "toxic-keepalive") {
    // Just being called keeps the SW alive. Check if we still need it.
    stopKeepAliveIfIdle();
  }
});

// --- Context Menu ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "toxic-download-video", title: "Download with Toxic Downloader", contexts: ["video"] });
  chrome.contextMenus.create({ id: "toxic-scan-page", title: "Scan page for videos", contexts: ["page"] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "toxic-download-video" && info.srcUrl) {
    const ext = getExtFromUrl(info.srcUrl);
    chrome.downloads.download({ url: info.srcUrl, filename: "video_" + Date.now() + "." + ext, saveAs: true });
  }
  if (info.menuItemId === "toxic-scan-page" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { action: "scan" }).catch(() => {});
  }
});

// --- Download History ---

async function addToHistory(entry) {
  try {
    const { downloadHistory = [] } = await chrome.storage.local.get("downloadHistory");
    downloadHistory.unshift(entry);
    // Keep last 200 entries
    if (downloadHistory.length > 200) downloadHistory.length = 200;
    await chrome.storage.local.set({ downloadHistory });
  } catch (_) {}
}

// --- Message Handler ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg.action === "videoFound" && tabId) {
    if (!videoStore[tabId]) videoStore[tabId] = [];
    const exists = videoStore[tabId].some((v) => v.url.split("?")[0] === msg.video.url.split("?")[0]);
    if (!exists) {
      videoStore[tabId].push(msg.video);
      const count = videoStore[tabId].filter(v => !v.isTrailer).length;
      chrome.action.setBadgeText({ text: count > 0 ? String(count) : "", tabId });
      chrome.action.setBadgeBackgroundColor({ color: "#7c3aed", tabId });
    }
  }

  if (msg.action === "videosUpdated" && tabId) {
    videoStore[tabId] = msg.videos;
    const count = msg.videos.filter(v => !v.isTrailer).length;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : "", tabId });
  }

  if (msg.action === "getStoredVideos") {
    sendResponse({ videos: videoStore[msg.tabId] || [] });
  }

  if (msg.action === "getProgress") {
    sendResponse({ progress: downloadProgress[msg.id] || null });
  }

  if (msg.action === "getActiveDownloads") {
    sendResponse({ activeDownloads: { ...activeDownloads }, progress: { ...downloadProgress } });
  }

  // Get ALL active downloads globally (across all tabs) with filenames
  if (msg.action === "getAllActiveDownloads") {
    const active = [];
    for (const [url, dlId] of Object.entries(activeDownloads)) {
      const prog = downloadProgress[dlId];
      if (!prog) continue;
      const name = activeDownloadNames[dlId] || downloadSegmentState[dlId]?.filename || "download";
      active.push({
        url,
        dlId,
        filename: name,
        status: prog.status,
        percent: prog.percent,
        text: prog.text,
        downloadedBytes: prog.downloadedBytes || 0,
        speed: prog.speed || "",
      });
    }
    sendResponse({ downloads: active });
  }

  if (msg.action === "hlsProgress") {
    downloadProgress[msg.id] = msg.progress;
  }

  if (msg.action === "getQualities") {
    fetchQualitiesWithAuth(msg.url, msg.pageUrl).then(q => sendResponse({ qualities: q })).catch(() => sendResponse({ qualities: [] }));
    return true;
  }

  if (msg.action === "subtitleFound" && tabId) {
    if (!subtitleStore[tabId]) subtitleStore[tabId] = [];
    if (!subtitleStore[tabId].some(s => s.url === msg.subtitle.url)) {
      subtitleStore[tabId].push(msg.subtitle);
    }
  }

  if (msg.action === "getSubtitles") {
    sendResponse({ subtitles: subtitleStore[msg.tabId] || [] });
  }

  if (msg.action === "downloadSubtitle") {
    downloadSubtitleFile(msg.url, msg.filename, true).then(result => {
      sendResponse(result);
    });
    return true;
  }

  if (msg.action === "getHistory") {
    chrome.storage.local.get("downloadHistory", (data) => {
      sendResponse({ history: data.downloadHistory || [] });
    });
    return true;
  }

  if (msg.action === "clearHistory") {
    chrome.storage.local.set({ downloadHistory: [] }, () => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === "deleteHistoryEntry") {
    chrome.storage.local.get("downloadHistory", (data) => {
      const history = data.downloadHistory || [];
      if (msg.index >= 0 && msg.index < history.length) {
        history.splice(msg.index, 1);
        chrome.storage.local.set({ downloadHistory: history }, () => sendResponse({ ok: true }));
      } else {
        sendResponse({ ok: false });
      }
    });
    return true;
  }

  if (msg.action === "getLog") {
    sendResponse({ log: activityLog });
    return true;
  }

  if (msg.action === "clearLog") {
    activityLog.length = 0;
    chrome.storage.local.set({ activityLog: [] });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === "getLastEmbedResult") {
    chrome.storage.local.get("lastEmbedResult", (data) => {
      sendResponse({ result: data.lastEmbedResult || "No embed attempted yet" });
    });
    return true;
  }

  if (msg.action === "openSidePanel") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) chrome.sidePanel.open({ tabId: tabs[0].id });
    });
  }

  if (msg.action === "hlsStart") {
    const { dlId, url, filename, referer, origin, selectedQuality } = msg;
    hlsDownloadTabs[dlId] = tabId;
    downloadProgress[dlId] = { status: "downloading", percent: 0, text: "Fetching cookies...", downloadedBytes: 0, speed: "" };
    startKeepAlive();

    getAllCookiesForUrl(url).then((cookieStr) => {
      downloadStream(url, filename, dlId, cookieStr, referer, origin, selectedQuality).catch((err) => {
        downloadProgress[dlId] = { ...downloadProgress[dlId], status: "error", percent: 0, text: "Failed: " + err.message };
        sendNotification("Download Failed", filename + " — " + err.message);
      });
    });
  }

  if (msg.action === "downloadVideo") {
    const { url, filename, tabId: requestTabId, selectedQuality } = msg;
    const ext = getExtFromUrl(url);

    if (ext === "m3u8" || ext === "mpd") {
      if (activeDownloads[url]) {
        sendResponse({ success: true, hlsDownload: true, id: activeDownloads[url] });
        return true;
      }

      const dlId = Date.now().toString() + "_" + Math.random().toString(36).slice(2, 6);
      downloadProgress[dlId] = { status: "starting", percent: 0, text: "Starting...", downloadedBytes: 0, speed: "" };
      activeDownloads[url] = dlId;
      activeDownloadNames[dlId] = filename;

      chrome.tabs.sendMessage(requestTabId, {
        action: "downloadHLS", url, filename, dlId, selectedQuality,
      });

      sendResponse({ success: true, hlsDownload: true, id: dlId });
    } else {
      // Direct file — verify it's actually a video before downloading
      verifyAndDownload(url, filename, ext).then(result => {
        sendResponse(result);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    }
    return true;
  }

  // Pause/Resume/Cancel downloads
  if (msg.action === "pauseDownload") {
    pausedDownloads[msg.dlId] = true;
    if (downloadProgress[msg.dlId]) {
      downloadProgress[msg.dlId].status = "paused";
      downloadProgress[msg.dlId].text = "Paused — " + downloadProgress[msg.dlId].text;
    }
    sendResponse({ ok: true });
  }

  if (msg.action === "resumeDownload") {
    delete pausedDownloads[msg.dlId];
    const state = downloadSegmentState[msg.dlId];
    if (state && downloadProgress[msg.dlId]) {
      downloadProgress[msg.dlId].status = "downloading";
      downloadProgress[msg.dlId].text = "Resuming...";
      // The download loop checks pausedDownloads and will continue
    }
    sendResponse({ ok: true });
  }

  if (msg.action === "cancelDownload") {
    cancelledDownloads[msg.dlId] = true;
    delete pausedDownloads[msg.dlId];
    if (downloadProgress[msg.dlId]) {
      downloadProgress[msg.dlId].status = "error";
      downloadProgress[msg.dlId].text = "Cancelled";
    }
    // Tell content script to clear its buffers for this download
    const cancelTabId = hlsDownloadTabs[msg.dlId];
    if (cancelTabId) {
      chrome.tabs.sendMessage(cancelTabId, { action: "hlsClearBuffers", dlId: msg.dlId }).catch(() => {});
    }
    cleanupDownload(msg.dlId);
    sendResponse({ ok: true });
  }

  // Batch download (respects maxConcurrent setting)
  if (msg.action === "batchDownload") {
    const { videos, tabId: batchTabId } = msg;
    getSettings().then(settings => {
      const maxConcurrent = settings.maxConcurrent || 3;
      const results = [];
      let started = 0;

      // Count currently active stream downloads
      const currentActive = Object.keys(activeDownloads).length;

      for (const v of videos) {
        const ext = getExtFromUrl(v.url);
        if (ext === "m3u8" || ext === "mpd") {
          if (activeDownloads[v.url]) continue; // already downloading

          const dlId = Date.now().toString() + "_" + Math.random().toString(36).slice(2, 6);
          activeDownloads[v.url] = dlId;
          activeDownloadNames[dlId] = v.filename;

          if (started + currentActive < maxConcurrent) {
            downloadProgress[dlId] = { status: "starting", percent: 0, text: "Starting...", downloadedBytes: 0, speed: "" };
            chrome.tabs.sendMessage(batchTabId, { action: "downloadHLS", url: v.url, filename: v.filename, dlId });
            started++;
          } else {
            // Queue — poll until a slot opens
            downloadProgress[dlId] = { status: "queued", percent: 0, text: "Queued", downloadedBytes: 0, speed: "" };
            const queuedUrl = v.url;
            const queuedFilename = v.filename;
            const queuedDlId = dlId;
            const queuedTabId = batchTabId;
            (async function waitForSlot() {
              while (Object.keys(activeDownloads).length >= maxConcurrent) {
                if (cancelledDownloads[queuedDlId]) return;
                await new Promise(r => setTimeout(r, 2000));
              }
              if (cancelledDownloads[queuedDlId]) return;
              downloadProgress[queuedDlId].status = "starting";
              downloadProgress[queuedDlId].text = "Starting...";
              chrome.tabs.sendMessage(queuedTabId, { action: "downloadHLS", url: queuedUrl, filename: queuedFilename, dlId: queuedDlId });
            })();
          }
          results.push({ url: v.url, dlId, hlsDownload: true });
        } else {
          chrome.downloads.download({ url: v.url, filename: `${v.filename}.${ext}`, saveAs: false });
          results.push({ url: v.url, direct: true });
        }
      }
      sendResponse({ results });
    });
    return true;
  }
});

// --- Header Rules ---

async function setupHeaderRules(dlId, domain, cookies, referer, origin) {
  const base = nextRuleBase;
  nextRuleBase += 3;
  if (downloadProgress[dlId]) downloadProgress[dlId]._ruleIds = [base, base + 1, base + 2];

  const rules = [];
  if (cookies) rules.push({ id: base, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "Cookie", operation: "set", value: cookies }] }, condition: { urlFilter: "*://" + domain + "/*", resourceTypes: ["xmlhttprequest", "other"] } });
  if (referer) rules.push({ id: base + 1, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "Referer", operation: "set", value: referer }] }, condition: { urlFilter: "*://" + domain + "/*", resourceTypes: ["xmlhttprequest", "other"] } });
  if (origin) rules.push({ id: base + 2, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "Origin", operation: "set", value: origin }] }, condition: { urlFilter: "*://" + domain + "/*", resourceTypes: ["xmlhttprequest", "other"] } });
  if (rules.length > 0) await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
}

async function clearHeaderRules(dlId) {
  const ruleIds = downloadProgress[dlId]?._ruleIds;
  if (ruleIds) try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds }); } catch (_) {}
}

// --- Cookies ---

async function getAllCookiesForUrl(url) {
  try {
    const urlObj = new URL(url);
    const cookies = await chrome.cookies.getAll({ domain: urlObj.hostname });
    const parts = urlObj.hostname.split(".");
    let more = [];
    if (parts.length > 2) more = await chrome.cookies.getAll({ domain: "." + parts.slice(-2).join(".") });
    const seen = new Set();
    return [...cookies, ...more].filter(c => { if (seen.has(c.name)) return false; seen.add(c.name); return true; }).map(c => c.name + "=" + c.value).join("; ");
  } catch (_) { return ""; }
}

// --- Formatting ---

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec < 1024) return bytesPerSec + " B/s";
  if (bytesPerSec < 1048576) return (bytesPerSec / 1024).toFixed(0) + " KB/s";
  return (bytesPerSec / 1048576).toFixed(1) + " MB/s";
}

// --- Send segment buffers to content script ---

async function sendBuffersToTab(tabId, dlId, bufs) {
  const MAX_MSG_BYTES = 40 * 1024 * 1024;
  for (let s = 0; s < bufs.length; s++) {
    const buf = bufs[s];
    const bytes = new Uint8Array(buf);
    if (bytes.length > MAX_MSG_BYTES) {
      for (let offset = 0; offset < bytes.length; offset += MAX_MSG_BYTES) {
        const slice = bytes.subarray(offset, Math.min(offset + MAX_MSG_BYTES, bytes.length));
        let binary = "";
        for (let i = 0; i < slice.length; i++) binary += String.fromCharCode(slice[i]);
        await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tabId, {
            action: "hlsSegmentData", dlId, chunks: [btoa(binary)],
          }, (resp) => { chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(resp); });
        });
      }
    } else {
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, {
          action: "hlsSegmentData", dlId, chunks: [btoa(binary)],
        }, (resp) => { chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(resp); });
      });
    }
  }
}

// --- Verify & Download Direct Files ---

async function verifyAndDownload(url, filename, fallbackExt) {
  // Do a HEAD request to check the actual content type
  let contentType = "";
  let finalUrl = url;
  let realExt = fallbackExt;

  try {
    const resp = await fetch(url, { method: "HEAD", redirect: "follow" });
    contentType = resp.headers.get("content-type") || "";
    finalUrl = resp.url; // follow redirects

    // Check if the server is returning HTML instead of video
    if (contentType.includes("text/html") || contentType.includes("text/plain") || contentType.includes("application/json")) {
      return { success: false, error: "URL returns " + contentType.split(";")[0] + " instead of video. This might be a redirect or expired link." };
    }

    // Determine real extension from content-type
    if (contentType.includes("video/mp4") || contentType.includes("video/x-m4v")) realExt = "mp4";
    else if (contentType.includes("video/webm")) realExt = "webm";
    else if (contentType.includes("video/x-matroska")) realExt = "mkv";
    else if (contentType.includes("video/x-flv")) realExt = "flv";
    else if (contentType.includes("video/quicktime")) realExt = "mov";
    else if (contentType.includes("video/x-msvideo")) realExt = "avi";
    else if (contentType.includes("application/x-mpegURL") || contentType.includes("vnd.apple.mpegurl")) realExt = "m3u8";
    else if (contentType.includes("application/dash+xml")) realExt = "mpd";
    // If content-type is octet-stream or unknown, trust the URL extension
    else if (contentType.includes("application/octet-stream")) realExt = getExtFromUrl(finalUrl) || fallbackExt;
  } catch (_) {
    // HEAD failed — try downloading anyway with the URL extension
  }

  // If it turned out to be a stream, redirect to stream download
  if (realExt === "m3u8" || realExt === "mpd") {
    return { success: false, error: "This is a stream URL, not a direct file. Try scanning again." };
  }

  const fullFilename = `${filename}.${realExt}`;
  return new Promise((resolve) => {
    chrome.downloads.download({ url: finalUrl, filename: fullFilename, saveAs: true }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendNotification("Download Failed", fullFilename + " — " + chrome.runtime.lastError.message);
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        if (downloadId) monitorDirectDownload(downloadId, fullFilename);
        resolve({ success: true, downloadId });
      }
    });
  });
}

// --- Direct Download Monitor ---

function monitorDirectDownload(downloadId, filename) {
  chrome.downloads.onChanged.addListener(function listener(delta) {
    if (delta.id !== downloadId) return;
    if (delta.state) {
      if (delta.state.current === "complete") {
        chrome.downloads.search({ id: downloadId }, (items) => {
          const size = items?.[0]?.fileSize || 0;
          sendNotification("Download Complete", filename + (size ? " (" + formatBytes(size) + ")" : ""));
          addToHistory({ filename, size, date: Date.now(), type: "direct" });
        });
        chrome.downloads.onChanged.removeListener(listener);
      } else if (delta.state.current === "interrupted") {
        sendNotification("Download Failed", filename + " — interrupted");
        chrome.downloads.onChanged.removeListener(listener);
      }
    }
  });
}

// --- Quality Fetcher ---

async function fetchQualitiesWithAuth(masterUrl, pageUrl) {
  // Try without auth first (many m3u8 URLs have tokens in query string)
  try {
    const result = await fetchQualities(masterUrl);
    if (result.length > 0 && result[0].resolution !== "default") return result;
  } catch (_) {}

  // Try with auth headers
  const tempDlId = "_qual_" + Date.now();
  downloadProgress[tempDlId] = {};
  try {
    const cdnDomain = new URL(masterUrl).hostname;
    const cdnCookies = await getAllCookiesForUrl(masterUrl);
    const pageCookies = pageUrl ? await getAllCookiesForUrl(pageUrl) : "";
    const allCookies = [cdnCookies, pageCookies].filter(Boolean).join("; ");
    await setupHeaderRules(tempDlId, cdnDomain, allCookies, pageUrl || "", pageUrl ? new URL(pageUrl).origin : "");
    const result = await fetchQualities(masterUrl);
    await clearHeaderRules(tempDlId);
    delete downloadProgress[tempDlId];
    return result;
  } catch (e) {
    await clearHeaderRules(tempDlId);
    delete downloadProgress[tempDlId];
    return [];
  }
}

async function fetchQualities(masterUrl) {
  try {
    const text = await fetchText(masterUrl);
    let variants = [];

    if (text.includes("#EXT-X-STREAM-INF")) {
      variants = parseHLSVariants(text).sort((a, b) => b.bandwidth - a.bandwidth);
      // Estimate duration from a media playlist to calculate sizes
      if (variants.length > 0) {
        try {
          const firstVariantUrl = resolveUrl(masterUrl, variants[0].uri);
          const mediaText = await fetchText(firstVariantUrl);
          const durations = [];
          mediaText.split("\n").forEach(line => {
            const m = line.match(/#EXTINF:([\d.]+)/);
            if (m) durations.push(parseFloat(m[1]));
          });
          const totalDuration = durations.reduce((a, b) => a + b, 0);
          if (totalDuration > 0) {
            for (const v of variants) {
              v.estimatedSize = Math.round((v.bandwidth / 8) * totalDuration);
            }
          }
        } catch (_) {}
      }
    } else if (text.includes("<MPD") || text.includes("<AdaptationSet")) {
      variants = parseDASHQualities(text);
      // Estimate from MPD duration
      try {
        const durMatch = text.match(/mediaPresentationDuration="([^"]+)"/);
        if (durMatch) {
          const m = durMatch[1].match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
          if (m) {
            const totalSec = (parseInt(m[1] || "0") * 3600) + (parseInt(m[2] || "0") * 60) + parseFloat(m[3] || "0");
            for (const v of variants) {
              v.estimatedSize = Math.round((v.bandwidth / 8) * totalSec);
            }
          }
        }
      } catch (_) {}
    }

    return variants.length > 0 ? variants : [{ resolution: "default", bandwidth: 0, uri: masterUrl }];
  } catch (_) { return []; }
}

// --- Notifications ---

async function sendNotification(title, message) {
  const settings = await getSettings();
  if (!settings.notifications) return;
  try { chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message }); } catch (_) {}
}

// --- Filename Templates ---

function applyFilenameTemplate(template, video) {
  if (!template) return video.filename;
  const vars = {
    title: video.movieName || video.showName || "video",
    show: video.showName || video.movieName || "video",
    season: video.season != null ? String(video.season).padStart(2, "0") : "",
    episode: video.episode != null ? String(video.episode).padStart(2, "0") : "",
    episode_name: video.episodeName || "",
    quality: video.quality || "",
    type: video.type || "",
  };
  let result = template;
  for (const [key, val] of Object.entries(vars)) {
    result = result.replace(new RegExp("\\{" + key + "\\}", "gi"), val);
  }
  return result.replace(/[<>:"/\\|?*]+/g, "").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").substring(0, 200) || video.filename;
}

// --- Save separate subtitle from background ---
function saveSeparateSubtitle_bg(videoFilename, subtitleData) {
  const baseName = videoFilename.replace(/\.[^.]+$/, "");
  const lang = (subtitleData.lang || "en").replace(/[^a-zA-Z]/g, "").substring(0, 3) || "en";
  const subFilename = baseName + "." + lang + ".srt";
  const blob = new Blob([subtitleData.text], { type: "application/x-subrip" });
  const reader = new FileReader();
  reader.onload = () => {
    chrome.downloads.download({ url: reader.result, filename: subFilename, saveAs: false });
  };
  reader.readAsDataURL(blob);
}

// --- Auto-download Subtitles ---

async function autoDownloadSubtitles(tabId, videoFilename) {
  const settings = await getSettings();
  if (!settings.subtitleAutoDownload) return;

  const subs = subtitleStore[tabId];
  if (!subs || subs.length === 0) return;

  const baseName = videoFilename.replace(/\.[^.]+$/, "");

  for (const sub of subs) {
    const safeLang = (sub.lang || "unknown").replace(/[^a-zA-Z0-9]/g, "");
    const safeType = (sub.type || "vtt").replace(/[^a-zA-Z0-9]/g, "");
    // Jellyfin/Plex naming: VideoName.lang.srt
    const subFilename = baseName + "." + safeLang + "." + safeType;
    try {
      await downloadSubtitleFile(sub.url, subFilename, false);
    } catch (_) {}
  }
}

// --- Subtitle Download with optional VTT-to-SRT conversion ---

async function downloadSubtitleFile(url, filename, saveAs) {
  const safeFilename = (filename || "subtitle.vtt")
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\.\./g, "")
    .replace(/^\/+/, "")
    .substring(0, 200);

  const settings = await getSettings();
  const isVtt = safeFilename.endsWith(".vtt") || url.match(/\.vtt(\?|$)/i);

  if (settings.convertVttToSrt && isVtt) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const vttText = await resp.text();
      const srtText = convertVttToSrt(vttText);
      const srtFilename = safeFilename.replace(/\.vtt$/i, ".srt");

      // Create blob URL for the converted content
      const blob = new Blob([srtText], { type: "application/x-subrip" });
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      return new Promise((resolve) => {
        chrome.downloads.download({ url: dataUrl, filename: srtFilename, saveAs }, (id) => {
          resolve({ success: !chrome.runtime.lastError, downloadId: id });
        });
      });
    } catch (_) {
      // Conversion failed — fall back to downloading the VTT as-is
    }
  }

  // Download as-is (no conversion)
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename: safeFilename, saveAs }, (id) => {
      resolve({ success: !chrome.runtime.lastError, downloadId: id });
    });
  });
}

// --- VTT to SRT Converter ---

function convertVttToSrt(vttText) {
  const lines = vttText.split(/\r?\n/);
  const srtBlocks = [];
  let blockNum = 1;
  let i = 0;

  // Skip WEBVTT header and any metadata
  while (i < lines.length && !lines[i].includes("-->")) i++;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Look for timestamp line: 00:00:00.000 --> 00:00:05.000
    if (line.includes("-->")) {
      // Convert VTT timestamps to SRT format (. -> , for milliseconds)
      const timestamp = line
        .replace(/\./g, ",")
        // Strip position/alignment metadata after timestamps
        .replace(/\s+(position|align|size|line|vertical):.*$/gi, "")
        .trim();

      // Ensure timestamps have hours (SRT requires HH:MM:SS,mmm)
      const parts = timestamp.split("-->");
      const fixTime = (t) => {
        t = t.trim();
        // If format is MM:SS,mmm, prepend 00:
        if (t.match(/^\d{2}:\d{2},\d{3}$/)) t = "00:" + t;
        return t;
      };
      const fixedTimestamp = fixTime(parts[0]) + " --> " + fixTime(parts[1]);

      // Collect subtitle text lines
      const textLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "") {
        let textLine = lines[i];
        // Strip VTT-specific tags like <c>, <b>, <i>, <u>, <v>, <lang>
        textLine = textLine
          .replace(/<\/?[cbiu]>/gi, "")
          .replace(/<\/?v[^>]*>/gi, "")
          .replace(/<\/?lang[^>]*>/gi, "")
          .replace(/<\/?ruby>/gi, "")
          .replace(/<\/?rt>/gi, "")
          .replace(/<\d{2}:\d{2}[:\d.,]*>/g, ""); // inline timestamps
        textLines.push(textLine);
        i++;
      }

      if (textLines.length > 0) {
        srtBlocks.push(blockNum + "\n" + fixedTimestamp + "\n" + textLines.join("\n"));
        blockNum++;
      }
    } else {
      i++;
    }
  }

  return srtBlocks.join("\n\n") + "\n";
}

// --- Unified Stream Download (HLS + DASH) ---

async function downloadStream(masterUrl, filename, dlId, cookies, referer, origin, selectedQuality) {
  const settings = await getSettings();
  const outputFormat = settings.outputFormat || "mp4";

  const cdnCookies = await getAllCookiesForUrl(masterUrl);
  const pageCookies = await getAllCookiesForUrl(referer);
  const allCookies = [cdnCookies, pageCookies, cookies].filter(Boolean).join("; ");

  const cdnDomain = new URL(masterUrl).hostname;
  await setupHeaderRules(dlId, cdnDomain, allCookies, referer, origin);

  let downloadedBytes = 0;
  let lastSpeedCheck = Date.now();
  let lastSpeedBytes = 0;
  let currentSpeed = "";

  const update = (status, percent, text) => {
    // Calculate speed
    const now = Date.now();
    const elapsed = (now - lastSpeedCheck) / 1000;
    if (elapsed >= 1) {
      const bytesInPeriod = downloadedBytes - lastSpeedBytes;
      currentSpeed = formatSpeed(Math.round(bytesInPeriod / elapsed));
      lastSpeedCheck = now;
      lastSpeedBytes = downloadedBytes;
    }
    downloadProgress[dlId] = { ...downloadProgress[dlId], status, percent, text, downloadedBytes, speed: currentSpeed };
  };

  try {
    update("downloading", 1, "Fetching playlist...");
    const masterText = await fetchText(masterUrl);

    let segments;
    let streamType;

    // Detect HLS vs DASH
    if (masterText.includes("#EXTM3U") || masterText.includes("#EXT-X")) {
      streamType = "hls";
      segments = await resolveHLSSegments(masterText, masterUrl, selectedQuality, update);
    } else if (masterText.includes("<MPD") || masterText.includes("<AdaptationSet")) {
      streamType = "dash";
      segments = await resolveDASHSegments(masterText, masterUrl, selectedQuality, update);
    } else {
      throw new Error("Unknown stream format");
    }

    if (!segments || segments.length === 0) throw new Error("No segments found");

    // Check for HLS encryption
    let decryptionKey = null;
    if (streamType === "hls" && segments._keyInfo) {
      update("downloading", 4, "Fetching decryption key...");
      const keyUrl = resolveUrl(segments._mediaUrl || masterUrl, segments._keyInfo.uri);
      const keyBuffer = await fetchBinary(keyUrl);
      decryptionKey = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["decrypt"]);
    }
    const keyInfo = segments._keyInfo || null;

    const total = segments.length;
    const buffers = [];
    const BATCH = 6;
    const bwLimit = settings.bandwidthLimit || 0;

    // Save segment state for resume capability
    downloadSegmentState[dlId] = { completedSegments: 0, totalSegments: total, masterUrl, filename, referer, origin, selectedQuality };

    for (let i = 0; i < total; i += BATCH) {
      // Check for cancel
      if (cancelledDownloads[dlId]) {
        delete cancelledDownloads[dlId];
        throw new Error("Cancelled");
      }

      // Check for pause - wait until unpaused
      while (pausedDownloads[dlId]) {
        await new Promise(r => setTimeout(r, 500));
        if (cancelledDownloads[dlId]) {
          delete cancelledDownloads[dlId];
          throw new Error("Cancelled");
        }
      }

      const batch = segments.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(seg => fetchBinary(seg.url)));

      for (let j = 0; j < results.length; j++) {
        let data = results[j];
        downloadedBytes += data.byteLength;

        if (decryptionKey && keyInfo) {
          const iv = keyInfo.iv || buildIV(i + j);
          data = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, decryptionKey, data);
        }
        buffers.push(data);
      }

      // Bandwidth throttle: if we're downloading too fast, delay
      if (bwLimit > 0) {
        const now = Date.now();
        const elapsedSec = (now - lastSpeedCheck) / 1000;
        if (elapsedSec > 0) {
          const currentRate = (downloadedBytes - lastSpeedBytes) / elapsedSec;
          if (currentRate > bwLimit) {
            const overageBytes = (downloadedBytes - lastSpeedBytes) - (bwLimit * elapsedSec);
            const delayMs = Math.round((overageBytes / bwLimit) * 1000);
            if (delayMs > 50) await new Promise(r => setTimeout(r, Math.min(delayMs, 5000)));
          }
        }
      }

      const done = Math.min(i + BATCH, total);
      downloadSegmentState[dlId].completedSegments = done;
      const pct = Math.round(5 + (done / total) * 88);
      const speedStr = currentSpeed ? " @ " + currentSpeed : "";
      update("downloading", pct, done + "/" + total + " segments (" + formatBytes(downloadedBytes) + ")" + speedStr);
    }

    delete downloadSegmentState[dlId];

    const tabIdForSave = hlsDownloadTabs[dlId];
    if (!tabIdForSave) throw new Error("Lost reference to download tab");

    const remuxEngine = settings.remuxEngine || "builtin";

    // Separate video and audio buffers for DASH with separate audio track
    const hasAudioTrack = segments.some(s => s.isAudio);
    let videoBuffers = buffers;
    let audioBuffers = [];
    if (hasAudioTrack) {
      videoBuffers = [];
      audioBuffers = [];
      for (let i = 0; i < buffers.length; i++) {
        if (segments[i]?.isAudio) audioBuffers.push(buffers[i]);
        else videoBuffers.push(buffers[i]);
      }
      log("[dash] Separated " + videoBuffers.length + " video + " + audioBuffers.length + " audio segments");
    }

    // Fetch subtitle data if embed setting is on, or native engine (FFmpeg embeds easily)
    update("downloading", 95, "Processing " + formatBytes(downloadedBytes) + "...");
    let subtitleData = null;
    const shouldEmbed = (settings.embedSubtitles || remuxEngine === "native") && outputFormat === "mp4";
    if (shouldEmbed) {
      const subs = subtitleStore[tabIdForSave];
      if (!subs || subs.length === 0) {
        log("[subs] No subtitles in store for tab " + tabIdForSave);
      } else {
        update("downloading", 95, "Fetching subtitle for embed...");

        // Method 1: Fetch via content script (has page cookies)
        try {
          const subResult = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tabIdForSave, {
              action: "fetchSubtitle", url: subs[0].url,
            }, (resp) => {
              if (chrome.runtime.lastError) resolve(null);
              else if (!resp?.text) resolve(null);
              else resolve(resp.text);
            });
          });
          if (subResult) {
            let subText = subResult;
            if (subs[0].type === "vtt" || subText.trimStart().startsWith("WEBVTT")) {
              subText = convertVttToSrt(subText);
            }
            subtitleData = { text: subText, lang: subs[0].lang || "und" };
            log("[subs] Fetched via content script (" + subText.length + " chars)");
          }
        } catch (_) {}

        // Method 2: Fallback - fetch from background with auth headers
        if (!subtitleData) {
          try {
            const subDomain = new URL(subs[0].url).hostname;
            const tempId = "_sub_" + Date.now();
            downloadProgress[tempId] = {};
            const subCookies = await getAllCookiesForUrl(subs[0].url);
            await setupHeaderRules(tempId, subDomain, subCookies, referer, origin);
            const subResp = await fetch(subs[0].url);
            await clearHeaderRules(tempId);
            delete downloadProgress[tempId];
            if (subResp.ok) {
              let subText = await subResp.text();
              if (subs[0].type === "vtt" || subText.trimStart().startsWith("WEBVTT")) {
                subText = convertVttToSrt(subText);
              }
              subtitleData = { text: subText, lang: subs[0].lang || "und" };
              log("[subs] Fetched via background (" + subText.length + " chars)");
            }
          } catch (_) {}
        }

        if (!subtitleData) {
          log("[subs] Could not fetch subtitle — saving without embed");
        }
      }
    }

    log("[remux] Engine: " + remuxEngine + " | Format: " + outputFormat + " | Size: " + formatBytes(downloadedBytes) + " | Subs: " + (subtitleData ? subtitleData.text.length + " chars" : "none") + " | Audio track: " + hasAudioTrack);

    if (remuxEngine === "native") {
      // --- Native FFmpeg path ---
      const fileExt = streamType === "dash" ? ".mp4" : ".ts";

      // Save video segments
      update("downloading", 96, "Saving video data for FFmpeg...");
      await sendBuffersToTab(tabIdForSave, dlId, videoBuffers);
      await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabIdForSave, {
          action: "hlsSaveRaw", dlId, filename: filename + fileExt,
        }, (resp) => { chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(resp); });
      });

      // Save audio segments separately if DASH with separate audio
      if (audioBuffers.length > 0) {
        update("downloading", 97, "Saving audio data for FFmpeg...");
        await sendBuffersToTab(tabIdForSave, dlId, audioBuffers);
        await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tabIdForSave, {
            action: "hlsSaveRaw", dlId, filename: filename + "_audio" + fileExt,
          }, (resp) => { chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(resp); });
        });
      }

      update("downloading", 98, "Waiting for file save...");
      await new Promise(r => setTimeout(r, 3000));

      // Find saved files
      const downloads = await new Promise(r => chrome.downloads.search({ orderBy: ["-startTime"], limit: 20 }, r));
      log("[native] Recent downloads: " + (downloads || []).map(d => d.filename?.split(/[/\\]/).pop() + " (" + d.state + ")").join(", "));

      const videoDownload = downloads?.find(d => d.filename && d.state === "complete" && d.filename.includes(filename) && !d.filename.includes("_audio"));
      let audioPath = "";
      if (audioBuffers.length > 0) {
        const audioDownload = downloads?.find(d => d.filename && d.state === "complete" && d.filename.includes(filename + "_audio"));
        if (audioDownload?.filename) audioPath = audioDownload.filename;
        else log("[native] Warning: could not find audio file");
      }

      if (videoDownload?.filename) {
        log("[native] Video: " + videoDownload.filename + (audioPath ? " | Audio: " + audioPath : ""));
        update("downloading", 99, "Remuxing with FFmpeg...");
        try {
          const nativeResult = await new Promise((resolve, reject) => {
            try {
              chrome.runtime.sendNativeMessage("com.toxicdownloader.ffmpeg", {
                action: "remux",
                inputPath: videoDownload.filename,
                audioPath: audioPath,
                subtitleText: subtitleData?.text || "",
                subtitleLang: subtitleData?.lang || "eng",
                ffmpegPath: settings.ffmpegPath || "ffmpeg",
              }, (resp) => {
                if (chrome.runtime.lastError) {
                  log("[native] sendNativeMessage error: " + chrome.runtime.lastError.message);
                  resolve({ success: false, error: chrome.runtime.lastError.message });
                } else {
                  resolve(resp);
                }
              });
            } catch (e) {
              log("[native] sendNativeMessage exception: " + e.message);
              resolve({ success: false, error: e.message });
            }
          });

          log("[native] Result: " + JSON.stringify(nativeResult));
          if (nativeResult?.success) {
            update("done", 100, "Remuxed with FFmpeg! " + formatBytes(nativeResult.size || downloadedBytes));
            sendNotification("Download Complete", filename + ".mp4 (remuxed with FFmpeg)");
          } else {
            update("done", 100, "FFmpeg failed: " + (nativeResult?.error || "unknown") + " — raw file saved");
            log("[native] FAILED: " + (nativeResult?.error || "no response"));
            sendNotification("Download Saved", filename + fileExt + " (FFmpeg remux failed)");
          }
        } catch (e) {
          log("[native] Exception: " + e.message);
          update("done", 100, "Native host error: " + e.message + " — raw file saved");
        }
      } else {
        log("[native] Could not find downloaded video file");
        update("done", 100, "Could not locate saved file for FFmpeg processing — raw file saved");
      }
    } else {
      // --- Built-in remux (default) — send to content script ---
      update("downloading", 96, "Combining " + formatBytes(downloadedBytes) + "...");
      await sendBuffersToTab(tabIdForSave, dlId, buffers);

      update("downloading", 99, "Saving...");
      log("[builtin] Sending to content script for save/remux. File: " + filename + "." + outputFormat);
      await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabIdForSave, {
          action: "hlsSave", dlId, filename: filename + "." + outputFormat, subtitleData,
        }, (resp) => { chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(resp); });
      });
      log("[builtin] Content script save complete");

      update("done", 100, "Complete! " + formatBytes(downloadedBytes));
      sendNotification("Download Complete", filename + " (" + formatBytes(downloadedBytes) + ")");
    }

    await clearHeaderRules(dlId);
    addToHistory({ filename, size: downloadedBytes, date: Date.now(), type: streamType });

    if (!subtitleData) autoDownloadSubtitles(tabIdForSave, filename);

    cleanupDownload(dlId);

  } catch (err) {
    await clearHeaderRules(dlId);
    update("error", 0, "Failed: " + err.message);
    sendNotification("Download Failed", filename + " — " + err.message);
    cleanupDownload(dlId);
  }
}

// --- HLS Resolution ---

async function resolveHLSSegments(masterText, masterUrl, selectedQuality, update) {
  let mediaUrl = masterUrl;
  let mediaText = masterText;

  if (masterText.includes("#EXT-X-STREAM-INF")) {
    const variants = parseHLSVariants(masterText);
    const variant = pickVariantByQuality(variants, selectedQuality);
    if (!variant) throw new Error("No video streams found");
    mediaUrl = resolveUrl(masterUrl, variant.uri);
    update("downloading", 3, "Selected " + (variant.resolution || "best") + " quality...");
    mediaText = await fetchText(mediaUrl);
  }

  const segments = mediaText.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#")).map(l => ({ url: resolveUrl(mediaUrl, l) }));

  // Attach encryption info
  const keyInfo = parseEncryptionKey(mediaText);
  if (keyInfo) { segments._keyInfo = keyInfo; segments._mediaUrl = mediaUrl; }

  return segments;
}

function parseHLSVariants(text) {
  const lines = text.split("\n");
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const bw = parseInt((line.match(/BANDWIDTH=(\d+)/) || [])[1] || "0", 10);
    const res = (line.match(/RESOLUTION=([\dx]+)/) || [])[1] || null;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (next && !next.startsWith("#")) { variants.push({ uri: next, bandwidth: bw, resolution: res }); break; }
    }
  }
  return variants;
}

// --- DASH Resolution ---

// --- Regex-based MPD XML helpers (DOMParser not available in service workers) ---

function xmlAttr(tag, name) {
  const m = tag.match(new RegExp(name + '="([^"]*)"'));
  return m ? m[1] : "";
}

function xmlFindAll(text, tagName) {
  const results = [];
  const openRe = new RegExp("<" + tagName + "[\\s>]", "gi");
  let match;
  while ((match = openRe.exec(text)) !== null) {
    const start = match.index;
    // Find the closing tag or self-closing
    const selfClose = text.indexOf("/>", start);
    const openEnd = text.indexOf(">", start);
    if (selfClose >= 0 && selfClose < openEnd + 1) {
      results.push(text.substring(start, selfClose + 2));
    } else {
      // Find matching close tag (simple, not nested)
      const closeTag = "</" + tagName + ">";
      const closeIdx = text.indexOf(closeTag, openEnd);
      if (closeIdx >= 0) {
        results.push(text.substring(start, closeIdx + closeTag.length));
      } else {
        results.push(text.substring(start, openEnd + 1));
      }
    }
  }
  return results;
}

function xmlInnerContent(tag, childTag) {
  const m = tag.match(new RegExp("<" + childTag + "[^>]*>([^<]*)</" + childTag + ">"));
  return m ? m[1].trim() : "";
}

// --- DASH Resolution (regex-based, no DOMParser) ---

async function resolveDASHSegments(mpdText, mpdUrl, selectedQuality, update) {
  const adaptationSets = xmlFindAll(mpdText, "AdaptationSet");
  let videoSetXml = null, audioSetXml = null;

  for (const asXml of adaptationSets) {
    const mime = xmlAttr(asXml, "mimeType");
    const ct = xmlAttr(asXml, "contentType");
    const reps = xmlFindAll(asXml, "Representation");
    const repMime = reps.length > 0 ? xmlAttr(reps[0], "mimeType") : "";
    if (mime.includes("video") || ct === "video" || repMime.includes("video")) {
      if (!videoSetXml) videoSetXml = asXml;
    } else if (mime.includes("audio") || ct === "audio" || repMime.includes("audio")) {
      if (!audioSetXml) audioSetXml = asXml;
    }
  }

  if (!videoSetXml) throw new Error("No video track found in DASH manifest");

  // Pick video representation
  const videoReps = xmlFindAll(videoSetXml, "Representation");
  videoReps.sort((a, b) => parseInt(xmlAttr(b, "bandwidth") || "0") - parseInt(xmlAttr(a, "bandwidth") || "0"));

  let chosenRep = videoReps[0];
  if (selectedQuality && selectedQuality !== "best") {
    const targetH = parseInt(selectedQuality, 10);
    const match = videoReps.find(r => parseInt(xmlAttr(r, "height") || "0") === targetH);
    if (match) chosenRep = match;
  }

  const repRes = (xmlAttr(chosenRep, "width") || "?") + "x" + (xmlAttr(chosenRep, "height") || "?");
  update("downloading", 3, "Selected " + repRes + " quality...");

  const segments = extractDASHSegments(mpdText, videoSetXml, chosenRep, mpdUrl);

  if (audioSetXml) {
    const audioReps = xmlFindAll(audioSetXml, "Representation");
    audioReps.sort((a, b) => parseInt(xmlAttr(b, "bandwidth") || "0") - parseInt(xmlAttr(a, "bandwidth") || "0"));
    if (audioReps.length > 0) {
      const audioSegs = extractDASHSegments(mpdText, audioSetXml, audioReps[0], mpdUrl);
      segments.push(...audioSegs.map(s => ({ ...s, isAudio: true })));
    }
  }

  return segments;
}

function extractDASHSegments(mpdText, adaptSetXml, repXml, mpdUrl) {
  const segments = [];
  const repId = xmlAttr(repXml, "id") || "1";
  const bandwidth = xmlAttr(repXml, "bandwidth") || "0";

  // Look for SegmentTemplate in rep first, then adaptationSet
  const tmplMatch = xmlFindAll(repXml, "SegmentTemplate")[0] || xmlFindAll(adaptSetXml, "SegmentTemplate")[0];

  if (tmplMatch) {
    const initTmpl = xmlAttr(tmplMatch, "initialization");
    const mediaTmpl = xmlAttr(tmplMatch, "media");

    if (initTmpl) {
      const initUrl = initTmpl.replace(/\$RepresentationID\$/g, repId).replace(/\$Bandwidth\$/g, bandwidth);
      segments.push({ url: resolveUrl(mpdUrl, initUrl), isInit: true });
    }

    // Check for SegmentTimeline
    const timelineEntries = xmlFindAll(tmplMatch, "S");
    if (timelineEntries.length > 0) {
      let time = 0;
      for (const s of timelineEntries) {
        const t = parseInt(xmlAttr(s, "t") || String(time), 10);
        const d = parseInt(xmlAttr(s, "d") || "0", 10);
        const r = parseInt(xmlAttr(s, "r") || "0", 10);
        time = t;
        for (let i = 0; i <= r; i++) {
          if (mediaTmpl) {
            const segUrl = mediaTmpl
              .replace(/\$RepresentationID\$/g, repId).replace(/\$Bandwidth\$/g, bandwidth)
              .replace(/\$Time\$/g, String(time)).replace(/\$Number\$/g, String(segments.length));
            segments.push({ url: resolveUrl(mpdUrl, segUrl) });
          }
          time += d;
        }
      }
    } else if (mediaTmpl) {
      // Number-based segments
      const startNumber = parseInt(xmlAttr(tmplMatch, "startNumber") || "1", 10);
      const duration = parseInt(xmlAttr(tmplMatch, "duration") || "0", 10);
      const timescale = parseInt(xmlAttr(tmplMatch, "timescale") || "1", 10);

      const durMatch = mpdText.match(/mediaPresentationDuration="([^"]+)"/);
      let totalSec = 600;
      if (durMatch) {
        const m = durMatch[1].match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
        if (m) totalSec = (parseInt(m[1] || "0") * 3600) + (parseInt(m[2] || "0") * 60) + parseFloat(m[3] || "0");
      }

      if (duration > 0) {
        const count = Math.ceil(totalSec / (duration / timescale));
        for (let n = startNumber; n < startNumber + count; n++) {
          const segUrl = mediaTmpl
            .replace(/\$RepresentationID\$/g, repId).replace(/\$Bandwidth\$/g, bandwidth)
            .replace(/\$Number\$/g, String(n)).replace(/\$Number%\d+d\$/g, String(n).padStart(5, "0"));
          segments.push({ url: resolveUrl(mpdUrl, segUrl) });
        }
      }
    }
    return segments;
  }

  // Check for SegmentList
  const segListXml = xmlFindAll(repXml, "SegmentList")[0] || xmlFindAll(adaptSetXml, "SegmentList")[0];
  if (segListXml) {
    const initMatch = segListXml.match(/<Initialization[^>]*sourceURL="([^"]*)"[^>]*\/?>/);
    if (initMatch) segments.push({ url: resolveUrl(mpdUrl, initMatch[1]), isInit: true });
    const segUrls = xmlFindAll(segListXml, "SegmentURL");
    for (const su of segUrls) {
      const media = xmlAttr(su, "media");
      if (media) segments.push({ url: resolveUrl(mpdUrl, media) });
    }
    return segments;
  }

  // BaseURL
  const baseContent = xmlInnerContent(repXml, "BaseURL") || xmlInnerContent(adaptSetXml, "BaseURL");
  if (baseContent) {
    segments.push({ url: resolveUrl(mpdUrl, baseContent) });
  }

  return segments;
}

function parseDASHQualities(mpdText) {
  try {
    const qualities = [];
    const adaptSets = xmlFindAll(mpdText, "AdaptationSet");
    for (const asXml of adaptSets) {
      const asMime = xmlAttr(asXml, "mimeType");
      const asCt = xmlAttr(asXml, "contentType");
      const reps = xmlFindAll(asXml, "Representation");
      for (const r of reps) {
        const mime = xmlAttr(r, "mimeType") || asMime;
        if (!mime.includes("video") && asCt !== "video") continue;
        const w = xmlAttr(r, "width");
        const h = xmlAttr(r, "height");
        const bw = parseInt(xmlAttr(r, "bandwidth") || "0", 10);
        const res = (w && h) ? w + "x" + h : null;
        qualities.push({ resolution: res, bandwidth: bw, uri: "" });
      }
    }
    return qualities.sort((a, b) => b.bandwidth - a.bandwidth);
  } catch (_) { return []; }
}

// --- Shared Helpers ---

function pickVariantByQuality(variants, selectedQuality) {
  if (!variants.length) return null;
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  if (selectedQuality && selectedQuality !== "best") {
    const target = parseInt(selectedQuality, 10);
    const match = variants.find(v => v.resolution && parseInt(v.resolution.split("x")[1]) === target);
    if (match) return match;
    const closest = variants.filter(v => v.resolution && parseInt(v.resolution.split("x")[1]) <= target);
    if (closest.length) return closest[0];
  }
  return variants[0];
}

function cleanupDownload(dlId) {
  for (const [url, id] of Object.entries(activeDownloads)) {
    if (id === dlId) { delete activeDownloads[url]; break; }
  }
  delete hlsDownloadTabs[dlId];
  delete pausedDownloads[dlId];
  delete cancelledDownloads[dlId];
  delete downloadSegmentState[dlId];
  delete activeDownloadNames[dlId];
  stopKeepAliveIfIdle();
  setTimeout(() => delete downloadProgress[dlId], 30000);
}

async function fetchText(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.text();
}

async function fetchBinary(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("HTTP " + resp.status + " on segment");
  return resp.arrayBuffer();
}

function parseEncryptionKey(text) {
  const m = text.match(/#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"(?:,IV=(0x[0-9a-fA-F]+))?/);
  if (!m) return null;
  let iv = null;
  if (m[2]) { const hex = m[2].replace("0x", ""); iv = new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16))); }
  return { uri: m[1], iv };
}

function buildIV(index) {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, index);
  return iv;
}

function resolveUrl(base, rel) {
  if (rel.startsWith("http://") || rel.startsWith("https://")) return rel;
  try { return new URL(rel, base).href; } catch (_) { const p = base.split("/"); p.pop(); return p.join("/") + "/" + rel; }
}

function getExtFromUrl(url) {
  try {
    const ext = new URL(url).pathname.split(".").pop().toLowerCase();
    if (["mp4", "mkv", "webm", "m3u8", "mpd", "avi", "flv", "mov", "m4v", "ts"].includes(ext)) return ext;
  } catch (_) {}
  return "mp4";
}

// --- Track tab URLs for SPA navigation detection ---
const tabUrls = {};

// --- Auto-scan on page load ---
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    // Always clear videoStore on navigation (fixes scan showing stale videos)
    delete videoStore[tabId];
    chrome.action.setBadgeText({ text: "", tabId });
    // Only clear subtitleStore if no active download needs it — downloads read subtitles from this store
    const tabHasActiveDownload = Object.values(hlsDownloadTabs).includes(tabId);
    if (!tabHasActiveDownload) {
      delete subtitleStore[tabId];
    }
  }

  // Detect SPA navigation (URL changed without full page reload)
  if (changeInfo.url) {
    const oldUrl = tabUrls[tabId];
    tabUrls[tabId] = changeInfo.url;
    if (oldUrl && oldUrl !== changeInfo.url) {
      delete videoStore[tabId];
      chrome.action.setBadgeText({ text: "", tabId });
      const tabHasActiveDownload = Object.values(hlsDownloadTabs).includes(tabId);
      if (!tabHasActiveDownload) {
        delete subtitleStore[tabId];
      }
      // Clear content script detection state (preserves hlsBuffers for active downloads)
      chrome.tabs.sendMessage(tabId, { action: "clearState" }).catch(() => {});
    }
  }
  if (changeInfo.status === "complete") {
    // Don't auto-scan chrome://, edge://, about:, or extension pages
    chrome.tabs.get(tabId, async (tab) => {
      if (chrome.runtime.lastError) return;
      const url = tab?.url || "";
      if (url.startsWith("chrome") || url.startsWith("edge") || url.startsWith("about") || url.startsWith("chrome-extension")) return;

      const settings = await getSettings();
      if (settings.autoScan) {
        chrome.tabs.sendMessage(tabId, { action: "scan" }).catch(() => {});
      }
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => { delete videoStore[tabId]; delete subtitleStore[tabId]; delete tabUrls[tabId]; });
