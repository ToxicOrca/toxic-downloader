// Toxic Downloader - Popup Script

const scanBtn = document.getElementById("scanBtn");
const statusEl = document.getElementById("status");
const videoListEl = document.getElementById("videoList");
const emptyStateEl = document.getElementById("emptyState");
const dockBtn = document.getElementById("dockBtn");

let currentVideos = [];
const activePolls = {}; // videoUrl -> { dlId, interval }
const isSidePanel = window.location.pathname.includes("sidepanel");

// Generate a short stable ID from a URL for DOM data attributes
function videoId(url) {
  let hash = 0;
  const str = url.split("?")[0];
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return "v" + Math.abs(hash).toString(36);
}

scanBtn.addEventListener("click", scan);
document.getElementById("batchBtn")?.addEventListener("click", confirmBatchDownload);
document.getElementById("historyBtn")?.addEventListener("click", showHistory);
document.getElementById("exportBtn")?.addEventListener("click", exportUrls);
document.getElementById("settingsBtn")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// Dock button - open side panel and close popup
if (dockBtn) {
  dockBtn.addEventListener("click", async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.sidePanel.open({ tabId: tab.id });
      }
      window.close();
    } catch (e) {
      // Fallback: just try to open it
      chrome.runtime.sendMessage({ action: "openSidePanel" });
      window.close();
    }
  });
}

// In side panel mode, auto-refresh when the active tab changes
if (isSidePanel) {
  chrome.tabs.onActivated.addListener(() => {
    loadExisting();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "complete") {
      loadExisting();
    }
  });
}

loadExisting();
loadActiveDownloads();
// Refresh active downloads section periodically
setInterval(loadActiveDownloads, 1000);

async function loadExisting() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  chrome.runtime.sendMessage(
    { action: "getStoredVideos", tabId: tab.id },
    (resp) => {
      if (resp?.videos?.length) {
        currentVideos = resp.videos;
        renderVideos();
        reconnectActiveDownloads();
      } else {
        currentVideos = [];
        videoListEl.innerHTML = "";
        videoListEl.classList.add("hidden");
        emptyStateEl.classList.remove("hidden");
        statusEl.textContent = "Click Scan to detect videos on this page";
        statusEl.className = "status";
      }
    }
  );

  // Load subtitles
  const subSection = document.getElementById("subtitleSection");
  if (subSection) { subSection.innerHTML = ""; subSection.classList.add("hidden"); }
  chrome.runtime.sendMessage(
    { action: "getSubtitles", tabId: tab.id },
    (resp) => {
      if (resp?.subtitles?.length) {
        renderSubtitles(resp.subtitles);
      }
    }
  );
}

// --- Active Downloads Section (global, all tabs) ---

function loadActiveDownloads() {
  chrome.runtime.sendMessage({ action: "getAllActiveDownloads" }, (resp) => {
    if (chrome.runtime.lastError) return;
    const section = document.getElementById("activeDownloadsSection");
    if (!section) return;

    const downloads = resp?.downloads || [];
    // Filter to only active/paused/queued (not done/error)
    const active = downloads.filter(d => d.status === "downloading" || d.status === "paused" || d.status === "queued" || d.status === "starting");

    if (active.length === 0) {
      section.classList.add("hidden");
      section.innerHTML = "";
      return;
    }

    section.classList.remove("hidden");

    // Build the section without destroying existing DOM if count matches (prevents flicker)
    const existingItems = section.querySelectorAll(".active-dl-item");
    const needsRebuild = existingItems.length !== active.length;

    if (needsRebuild) {
      section.innerHTML = `<div class="active-dl-header">Active Downloads (${active.length})</div>`;
      active.forEach(dl => {
        const item = document.createElement("div");
        item.className = "active-dl-item";
        item.dataset.dlid = dl.dlId;
        item.innerHTML = buildActiveDlHtml(dl);
        section.appendChild(item);
      });
    } else {
      // Update existing items in place
      section.querySelector(".active-dl-header").textContent = `Active Downloads (${active.length})`;
      active.forEach((dl, i) => {
        const item = existingItems[i];
        if (item) {
          item.querySelector(".active-dl-fill").style.width = dl.percent + "%";
          item.querySelector(".active-dl-text").textContent = dl.text || dl.status;
          const speedEl = item.querySelector(".active-dl-speed");
          if (speedEl) speedEl.textContent = dl.speed || "";
        }
      });
    }
  });
}

function buildActiveDlHtml(dl) {
  const name = dl.filename.replace(/_/g, " ");
  const statusClass = dl.status === "paused" ? " paused" : "";
  return `
    <div class="active-dl-name">${escapeHtml(name)}</div>
    <div class="active-dl-progress${statusClass}">
      <div class="active-dl-bar">
        <div class="active-dl-fill" style="width: ${dl.percent}%"></div>
      </div>
      <div class="active-dl-info">
        <span class="active-dl-text">${escapeHtml(dl.text || dl.status)}</span>
        <span class="active-dl-speed">${escapeHtml(dl.speed || "")}</span>
      </div>
    </div>
  `;
}

function renderSubtitles(subtitles) {
  const section = document.getElementById("subtitleSection");
  if (!section) return;
  if (!subtitles.length) { section.classList.add("hidden"); section.innerHTML = ""; return; }

  section.classList.remove("hidden");
  section.innerHTML = `<div class="subtitle-header">Subtitles (${subtitles.length})</div>`;

  subtitles.forEach(sub => {
    const item = document.createElement("div");
    item.className = "subtitle-item";
    item.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2">
        <rect x="2" y="4" width="20" height="16" rx="2"/>
        <path d="M7 15h4m-4-3h10"/>
      </svg>
      <span class="subtitle-lang">${escapeHtml(sub.lang.toUpperCase())}</span>
      <span class="subtitle-type">${escapeHtml(sub.type)}</span>
      <button class="btn-sub-dl" title="Download subtitle">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </button>
    `;

    item.querySelector(".btn-sub-dl").addEventListener("click", () => {
      chrome.runtime.sendMessage({
        action: "downloadSubtitle",
        url: sub.url,
        filename: "subtitles_" + sub.lang + "." + sub.type,
      });
    });

    section.appendChild(item);
  });
}

function reconnectActiveDownloads() {
  chrome.runtime.sendMessage({ action: "getActiveDownloads" }, (resp) => {
    if (!resp) return;
    const { activeDownloads, progress } = resp;

    currentVideos.forEach((video) => {
      const dlId = activeDownloads[video.url];
      if (!dlId) return;

      const prog = progress[dlId];
      if (!prog || prog.status === "done" || prog.status === "error") return;

      const vid = videoId(video.url);
      const item = document.querySelector(`.video-item[data-vid="${vid}"]`);
      if (!item) return;

      const btn = item.querySelector(".btn-download");
      if (btn) btn.classList.add("downloading");

      showProgress(video.url, prog.percent, prog.text);
      pollProgress(dlId, btn, video.url);
    });
  });
}

async function scan() {
  scanBtn.classList.add("scanning");
  scanBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin">
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
    Scanning...
  `;
  statusEl.textContent = "Scanning page for video sources...";
  statusEl.className = "status";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { showError("No active tab found"); return; }

    chrome.tabs.sendMessage(tab.id, { action: "scan" }, (response) => {
      if (chrome.runtime.lastError) {
        showError("Cannot scan this page. Try refreshing first.");
        resetScanBtn();
        return;
      }

      const videos = response?.videos || [];

      chrome.runtime.sendMessage(
        { action: "getStoredVideos", tabId: tab.id },
        (bgResp) => {
          const bgVideos = bgResp?.videos || [];
          currentVideos = mergeVideos(videos, bgVideos);
          renderVideos();
          resetScanBtn();
          reconnectActiveDownloads();
        }
      );
    });
  } catch (err) {
    showError("Scan failed: " + err.message);
    resetScanBtn();
  }
}

function mergeVideos(a, b) {
  const seen = new Set();
  const result = [];
  for (const v of [...a, ...b]) {
    const key = v.url.split("?")[0];
    if (!seen.has(key)) {
      seen.add(key);
      result.push(v);
    }
  }
  return result;
}

function isStreamType(type) {
  return type === "m3u8" || type === "mpd";
}

function renderVideos() {
  if (currentVideos.length === 0) {
    emptyStateEl.classList.remove("hidden");
    videoListEl.classList.add("hidden");
    statusEl.textContent = "No videos found on this page";
    statusEl.className = "status";
    return;
  }

  emptyStateEl.classList.add("hidden");
  videoListEl.classList.remove("hidden");

  // Sort: non-trailers first, streams above direct files, longest duration first
  const sorted = [...currentVideos].sort((a, b) => {
    if (a.isTrailer && !b.isTrailer) return 1;
    if (!a.isTrailer && b.isTrailer) return -1;
    const aStream = isStreamType(a.type) ? 0 : 1;
    const bStream = isStreamType(b.type) ? 0 : 1;
    if (aStream !== bStream) return aStream - bStream;
    return (b.duration || 0) - (a.duration || 0);
  });
  currentVideos = sorted;

  const contentCount = sorted.filter(v => !v.isTrailer).length;
  const trailerCount = sorted.filter(v => v.isTrailer).length;
  let statusText = `Found ${sorted.length} video${sorted.length > 1 ? "s" : ""}`;
  if (trailerCount > 0) {
    statusText += ` (${contentCount} content, ${trailerCount} trailer${trailerCount > 1 ? "s" : ""})`;
  }
  statusEl.textContent = statusText;
  statusEl.className = "status found";

  videoListEl.innerHTML = "";

  sorted.forEach((video) => {
    const vid = videoId(video.url);
    const item = document.createElement("div");
    item.className = "video-item" + (video.isTrailer ? " trailer-item" : "");
    item.dataset.vid = vid;

    const qualityBadge = video.quality
      ? `<span class="quality">${video.quality}</span>` : "";
    const typeBadge = video.type
      ? `<span class="type-badge">${video.type}</span>` : "";
    const trailerBadge = video.isTrailer
      ? `<span class="trailer-badge">TRAILER</span>` : "";
    const durationText = video.duration
      ? `<span class="duration">${formatDuration(video.duration)}</span>` : "";
    const streamBadge = isStreamType(video.type)
      ? `<span class="stream-badge">STREAM</span>` : "";

    const displayName = getDisplayName(video);

    const thumbHtml = video.thumbnail
      ? `<div class="video-thumb"><img src="${escapeHtml(video.thumbnail)}" alt=""/></div>`
      : `<div class="video-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>`;

    item.innerHTML = `
      ${thumbHtml}
      <div class="video-info">
        <div class="video-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
        <div class="video-meta">
          ${trailerBadge}
          ${streamBadge}
          ${qualityBadge}
          ${typeBadge}
          ${durationText}
        </div>
        <div class="progress-container hidden" data-vid="${vid}">
          <div class="progress-bar"><div class="progress-fill"></div></div>
          <div class="progress-row">
            <span class="progress-text"></span>
            <div class="progress-controls hidden" data-vid="${vid}">
              <button class="prog-btn pause-btn" title="Pause">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
              </button>
              <button class="prog-btn cancel-btn" title="Cancel">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="btn-group">
        <button class="btn-download" data-vid="${vid}" title="Download">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>
        <button class="btn-copy" data-vid="${vid}" title="Copy URL">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
      </div>
    `;

    const dlBtn = item.querySelector(".btn-download");
    dlBtn.addEventListener("click", () => downloadVideo(video, dlBtn));

    const copyBtn = item.querySelector(".btn-copy");
    copyBtn.addEventListener("click", () => copyUrl(video.url, copyBtn));

    videoListEl.appendChild(item);
  });
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function getDisplayName(video) {
  if (video.isShow && video.showName && video.season != null && video.episode != null) {
    const s = String(video.season).padStart(2, "0");
    const e = String(video.episode).padStart(2, "0");
    return `${video.showName} S${s}E${e}`;
  }
  if (video.movieName) return video.movieName;
  if (video.filename) return video.filename.replace(/_/g, " ");
  return "Unknown Video";
}

async function downloadVideo(video, btn) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (isStreamType(video.type)) {
    btn.classList.add("downloading");
    showToast("Checking available qualities...");
    chrome.runtime.sendMessage({ action: "getQualities", url: video.url, pageUrl: tab?.url || "" }, (resp) => {
      btn.classList.remove("downloading");
      const qualities = resp?.qualities || [];

      if (qualities.length > 1) {
        showQualityPicker(video, qualities, btn, tab?.id);
      } else if (qualities.length === 1 && qualities[0].resolution && qualities[0].resolution !== "default") {
        showQualityPicker(video, qualities, btn, tab?.id);
      } else {
        // Single stream, no variants — download directly
        if (qualities.length === 0) {
          showToast("No quality options found — stream may only have one quality", true);
        } else {
          showToast("Single quality stream — downloading " + (qualities[0]?.resolution || "default"));
        }
        startDownload(video, btn, tab?.id, null);
      }
    });
  } else {
    startDownload(video, btn, tab?.id, null);
  }
}

function showQualityPicker(video, qualities, btn, tabId) {
  // Remove any existing picker
  document.querySelectorAll(".quality-picker").forEach(el => el.remove());

  const picker = document.createElement("div");
  picker.className = "quality-picker";
  picker.innerHTML = `
    <div class="quality-picker-title">Select Quality</div>
    ${qualities.map((q, i) => {
      const res = q.resolution || "Auto";
      const bw = q.bandwidth ? (q.bandwidth / 1000000).toFixed(1) + " Mbps" : "";
      const size = q.estimatedSize ? "~" + formatBytes(q.estimatedSize) : "";
      const meta = [bw, size].filter(Boolean).join(" / ");
      const height = q.resolution ? q.resolution.split("x")[1] + "p" : "best";
      return `<button class="quality-option" data-quality="${escapeHtml(height)}" data-index="${i}">
        <span class="quality-res">${escapeHtml(res)}</span>
        <span class="quality-bw">${meta ? "(" + escapeHtml(meta) + ")" : ""}</span>
      </button>`;
    }).join("")}
  `;

  picker.querySelectorAll(".quality-option").forEach(opt => {
    opt.addEventListener("click", () => {
      picker.remove();
      const selectedQuality = opt.dataset.quality;
      startDownload(video, btn, tabId, selectedQuality);
    });
  });

  // Insert picker after the video item
  const videoItem = btn.closest(".video-item");
  videoItem.parentNode.insertBefore(picker, videoItem.nextSibling);
}

function startDownload(video, btn, tabId, selectedQuality) {
  btn.classList.add("downloading");

  chrome.runtime.sendMessage(
    {
      action: "downloadVideo",
      url: video.url,
      filename: video.filename,
      tabId,
      selectedQuality,
    },
    (response) => {
      if (!response) { showError("No response from background"); btn.classList.remove("downloading"); return; }

      if (response.hlsDownload) {
        showProgress(video.url, 0, "Starting stream download...");
        pollProgress(response.id, btn, video.url);
      } else if (response.success) {
        showDownloadSuccess(btn);
      } else {
        showError(response.error || "Download failed");
        btn.classList.remove("downloading");
      }
    }
  );
}

function pollProgress(dlId, btn, videoUrl) {
  if (activePolls[videoUrl]) clearInterval(activePolls[videoUrl].interval);

  let isPaused = false;
  const vid = videoId(videoUrl);

  // Wire up pause/cancel buttons
  const container = document.querySelector(`.progress-container[data-vid="${vid}"]`);
  if (container) {
    const pauseBtn = container.querySelector(".pause-btn");
    const cancelBtn = container.querySelector(".cancel-btn");

    if (pauseBtn) {
      const newPauseBtn = pauseBtn.cloneNode(true);
      pauseBtn.replaceWith(newPauseBtn);
      newPauseBtn.addEventListener("click", () => {
        if (isPaused) {
          chrome.runtime.sendMessage({ action: "resumeDownload", dlId });
          isPaused = false;
          newPauseBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
          newPauseBtn.title = "Pause";
        } else {
          chrome.runtime.sendMessage({ action: "pauseDownload", dlId });
          isPaused = true;
          newPauseBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
          newPauseBtn.title = "Resume";
        }
      });
    }

    if (cancelBtn) {
      const newCancelBtn = cancelBtn.cloneNode(true);
      cancelBtn.replaceWith(newCancelBtn);
      newCancelBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ action: "cancelDownload", dlId });
      });
    }
  }

  const interval = setInterval(() => {
    chrome.runtime.sendMessage({ action: "getProgress", id: dlId }, (resp) => {
      if (chrome.runtime.lastError) { clearInterval(interval); return; }
      const prog = resp?.progress;
      if (!prog) return;

      showProgress(videoUrl, prog.percent, prog.text);

      if (prog.status === "paused") {
        isPaused = true;
      }

      if (prog.status === "done") {
        clearInterval(interval);
        delete activePolls[videoUrl];
        hideProgress(videoUrl);
        showDownloadSuccess(btn);
      } else if (prog.status === "error") {
        clearInterval(interval);
        delete activePolls[videoUrl];
        showProgress(videoUrl, 0, friendlyError(prog.text));
        showRetryButton(videoUrl, btn);
        if (btn) btn.classList.remove("downloading");
      }
    });
  }, 500);

  activePolls[videoUrl] = { dlId, interval };
}

function showProgress(videoUrl, percent, text) {
  const vid = videoId(videoUrl);
  const container = document.querySelector(`.progress-container[data-vid="${vid}"]`);
  if (!container) return;
  container.classList.remove("hidden");
  container.querySelector(".progress-fill").style.width = `${percent}%`;
  container.querySelector(".progress-text").textContent = text;

  const controls = container.querySelector(".progress-controls");
  if (controls) controls.classList.remove("hidden");
}

function hideProgress(videoUrl) {
  const vid = videoId(videoUrl);
  const container = document.querySelector(`.progress-container[data-vid="${vid}"]`);
  if (container) container.classList.add("hidden");
}

function showRetryButton(videoUrl, originalBtn) {
  const vid = videoId(videoUrl);
  const container = document.querySelector(`.progress-container[data-vid="${vid}"]`);
  if (!container) return;

  container.querySelectorAll(".retry-btn").forEach(el => el.remove());

  const retryBtn = document.createElement("button");
  retryBtn.className = "retry-btn";
  retryBtn.innerHTML = `
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
    Retry
  `;
  retryBtn.addEventListener("click", () => {
    hideProgress(videoUrl);
    retryBtn.remove();
    const video = currentVideos.find(v => v.url === videoUrl);
    if (video && originalBtn) {
      downloadVideo(video, originalBtn);
    }
  });

  container.querySelector(".progress-row").appendChild(retryBtn);
}

function showDownloadSuccess(btn) {
  if (!btn) return;
  btn.classList.remove("downloading");
  btn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  `;
  setTimeout(() => {
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
    `;
  }, 3000);
}

async function copyUrl(url, btn) {
  try {
    await navigator.clipboard.writeText(url);
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    `;
    setTimeout(() => {
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      `;
    }, 2000);
  } catch (_) {
    showError("Failed to copy URL");
  }
}

// --- Batch Download ---
function confirmBatchDownload() {
  const nonTrailers = currentVideos.filter(v => !v.isTrailer);
  if (nonTrailers.length === 0) {
    showError("No videos to download");
    return;
  }

  // Remove any existing confirm dialog
  document.querySelectorAll(".confirm-dialog").forEach(el => el.remove());

  const dialog = document.createElement("div");
  dialog.className = "confirm-dialog";
  dialog.innerHTML = `
    <div class="confirm-text">Download ${nonTrailers.length} video${nonTrailers.length > 1 ? "s" : ""}?</div>
    <div class="confirm-btns">
      <button class="confirm-yes">Yes, download all</button>
      <button class="confirm-no">Cancel</button>
    </div>
  `;

  dialog.querySelector(".confirm-yes").addEventListener("click", () => {
    dialog.remove();
    batchDownloadAll();
  });
  dialog.querySelector(".confirm-no").addEventListener("click", () => {
    dialog.remove();
  });

  videoListEl.parentNode.insertBefore(dialog, videoListEl);
}

async function batchDownloadAll() {
  const nonTrailers = currentVideos.filter(v => !v.isTrailer);
  if (nonTrailers.length === 0) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  chrome.runtime.sendMessage({
    action: "batchDownload",
    videos: nonTrailers.map(v => ({ url: v.url, filename: v.filename })),
    tabId: tab.id,
  }, (resp) => {
    if (resp?.results) {
      statusEl.textContent = `Started ${resp.results.length} downloads`;
      statusEl.className = "status found";
      // Reconnect to see progress
      setTimeout(() => reconnectActiveDownloads(), 1000);
    }
  });
}

// --- Download History ---
function showHistory() {
  chrome.runtime.sendMessage({ action: "getHistory" }, (resp) => {
    const history = resp?.history || [];
    if (history.length === 0) {
      statusEl.textContent = "No download history yet";
      statusEl.className = "status";
      return;
    }

    emptyStateEl.classList.add("hidden");
    videoListEl.classList.remove("hidden");
    videoListEl.innerHTML = "";

    // Show back button and search
    statusEl.innerHTML = `<span class="history-back" id="historyBack">Back</span> | ${history.length} downloads | <span class="history-clear" id="historyClear">Clear all</span>`;
    statusEl.className = "status found";

    document.getElementById("historyBack")?.addEventListener("click", () => loadExisting());
    document.getElementById("historyClear")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "clearHistory" }, () => {
        videoListEl.innerHTML = "";
        statusEl.textContent = "History cleared";
        statusEl.className = "status";
      });
    });

    // Search bar
    const searchDiv = document.createElement("div");
    searchDiv.className = "history-search";
    searchDiv.innerHTML = `<input type="text" id="historySearch" placeholder="Search history..." />`;
    videoListEl.appendChild(searchDiv);

    document.getElementById("historySearch")?.addEventListener("input", (e) => {
      const q = e.target.value.toLowerCase();
      videoListEl.querySelectorAll(".video-item").forEach(item => {
        const name = item.querySelector(".video-name")?.textContent?.toLowerCase() || "";
        item.style.display = name.includes(q) ? "" : "none";
      });
    });

    history.forEach((entry, i) => {
      const item = document.createElement("div");
      item.className = "video-item";
      const date = new Date(entry.date).toLocaleDateString();
      const size = entry.size ? formatBytes(entry.size) : "";
      item.innerHTML = `
        <div class="video-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <div class="video-info">
          <div class="video-name">${escapeHtml(entry.filename)}</div>
          <div class="video-meta">
            <span class="duration">${date}</span>
            ${size ? `<span class="quality">${size}</span>` : ""}
            <span class="type-badge">${entry.type || "direct"}</span>
          </div>
        </div>
        <button class="btn-history-del" data-index="${i}" title="Remove from history">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `;

      item.querySelector(".btn-history-del").addEventListener("click", () => {
        chrome.runtime.sendMessage({ action: "deleteHistoryEntry", index: i }, () => {
          showHistory(); // Refresh the list
        });
      });

      videoListEl.appendChild(item);
    });
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

// --- Export URLs ---
function exportUrls() {
  if (currentVideos.length === 0) {
    showError("No videos to export");
    return;
  }

  const lines = currentVideos.map(v => {
    const name = getDisplayName(v);
    const tag = v.isTrailer ? " [TRAILER]" : "";
    const qual = v.quality ? " [" + v.quality + "]" : "";
    const type = v.type ? " (" + v.type + ")" : "";
    return `# ${name}${tag}${qual}${type}\n${v.url}\n`;
  });

  const text = "# Toxic Downloader - Exported URLs\n# " + new Date().toISOString() + "\n\n" + lines.join("\n");
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "toxic_urls_" + Date.now() + ".txt";
  a.click();
  URL.revokeObjectURL(url);

  showToast("Exported " + currentVideos.length + " URLs");
}

function resetScanBtn() {
  scanBtn.classList.remove("scanning");
  scanBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
    </svg>
    Scan
  `;
}

function friendlyError(msg) {
  if (!msg) return "Unknown error";
  if (msg.includes("HTTP 403")) return "Access denied — the server rejected the request. Try refreshing the page.";
  if (msg.includes("HTTP 404")) return "Video not found — the stream URL may have expired. Try scanning again.";
  if (msg.includes("HTTP 429")) return "Too many requests — the server is rate limiting. Wait a moment and try again.";
  if (msg.includes("HTTP 5")) return "Server error — the video server is having issues. Try again later.";
  if (msg.includes("Failed to fetch")) return "Network error — couldn't reach the server. Check your connection.";
  if (msg.includes("Lost reference")) return "Tab was closed or navigated away during download.";
  if (msg.includes("Cancelled")) return "Download cancelled.";
  if (msg.includes("No segments")) return "No video segments found in the playlist.";
  if (msg.includes("No video streams")) return "No video streams found in the playlist.";
  if (msg.includes("Unknown stream format")) return "Unrecognized stream format — not HLS or DASH.";
  return msg;
}

function showError(msg) {
  showToast(friendlyError(msg), true);
}

function showToast(message, isError) {
  // Remove existing toasts
  document.querySelectorAll(".toast").forEach(el => el.remove());

  const toast = document.createElement("div");
  toast.className = "toast" + (isError ? " toast-error" : "");
  toast.textContent = message;
  document.body.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => toast.classList.add("toast-visible"));

  // Auto-dismiss
  setTimeout(() => {
    toast.classList.remove("toast-visible");
    setTimeout(() => toast.remove(), 300);
  }, isError ? 8000 : 5000);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

const style = document.createElement("style");
style.textContent = `
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;
document.head.appendChild(style);
