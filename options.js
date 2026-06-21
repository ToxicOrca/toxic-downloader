// Toxic Downloader - Options Page

const DEFAULTS = {
  defaultQuality: "best",
  filenameTemplate: "",
  maxConcurrent: 3,
  outputFormat: "mp4",
  remuxEngine: "builtin",
  ffmpegPath: "ffmpeg",
  bandwidthLimit: 0,
  autoScan: false,
  notifications: true,
  subtitleAutoDownload: false,
  convertVttToSrt: false,
  embedSubtitles: false,
};

const els = {
  defaultQuality: document.getElementById("defaultQuality"),
  filenameTemplate: document.getElementById("filenameTemplate"),
  maxConcurrent: document.getElementById("maxConcurrent"),
  outputFormat: document.getElementById("outputFormat"),
  remuxEngine: document.getElementById("remuxEngine"),
  ffmpegPath: document.getElementById("ffmpegPath"),
  ffmpegPathRow: document.getElementById("ffmpegPathRow"),
  bandwidthLimit: document.getElementById("bandwidthLimit"),
  autoScan: document.getElementById("autoScan"),
  notifications: document.getElementById("notifications"),
  subtitleAutoDownload: document.getElementById("subtitleAutoDownload"),
  convertVttToSrt: document.getElementById("convertVttToSrt"),
  embedSubtitles: document.getElementById("embedSubtitles"),
  templatePreview: document.getElementById("templatePreview"),
  saveBtn: document.getElementById("saveBtn"),
  resetBtn: document.getElementById("resetBtn"),
  toast: document.getElementById("toast"),
};

// Show/hide FFmpeg path based on engine selection
function updateEngineUI() {
  if (els.ffmpegPathRow) {
    els.ffmpegPathRow.classList.toggle("hidden", els.remuxEngine.value !== "native");
  }
}

els.remuxEngine.addEventListener("change", updateEngineUI);

// Load settings
chrome.storage.sync.get(DEFAULTS, (settings) => {
  els.defaultQuality.value = settings.defaultQuality;
  els.filenameTemplate.value = settings.filenameTemplate;
  els.maxConcurrent.value = settings.maxConcurrent;
  els.outputFormat.value = settings.outputFormat;
  els.remuxEngine.value = settings.remuxEngine;
  els.ffmpegPath.value = settings.ffmpegPath;
  els.bandwidthLimit.value = settings.bandwidthLimit ? settings.bandwidthLimit / 1048576 : 0;
  els.autoScan.checked = settings.autoScan;
  els.notifications.checked = settings.notifications;
  els.subtitleAutoDownload.checked = settings.subtitleAutoDownload;
  els.convertVttToSrt.checked = settings.convertVttToSrt;
  els.embedSubtitles.checked = settings.embedSubtitles;
  updatePreview();
  updateEngineUI();
});

// Template preview
els.filenameTemplate.addEventListener("input", updatePreview);

function updatePreview() {
  const template = els.filenameTemplate.value;
  if (!template) {
    els.templatePreview.textContent = "Preview: ShowName_S01E03.mp4 (auto)";
    return;
  }
  const example = template
    .replace(/\{title\}/gi, "Breaking_Bad")
    .replace(/\{show\}/gi, "Breaking_Bad")
    .replace(/\{season\}/gi, "01")
    .replace(/\{episode_name\}/gi, "Pilot")
    .replace(/\{episode\}/gi, "03")
    .replace(/\{quality\}/gi, "1080p")
    .replace(/\{type\}/gi, "m3u8");
  els.templatePreview.textContent = "Preview: " + example + ".mp4";
}

// Save
els.saveBtn.addEventListener("click", () => {
  const settings = {
    defaultQuality: els.defaultQuality.value,
    filenameTemplate: els.filenameTemplate.value.trim(),
    maxConcurrent: Math.max(1, Math.min(10, parseInt(els.maxConcurrent.value, 10) || 3)),
    outputFormat: els.outputFormat.value,
    remuxEngine: els.remuxEngine.value,
    ffmpegPath: els.ffmpegPath.value.trim() || "ffmpeg",
    bandwidthLimit: Math.max(0, parseFloat(els.bandwidthLimit.value) || 0) * 1048576,
    autoScan: els.autoScan.checked,
    notifications: els.notifications.checked,
    subtitleAutoDownload: els.subtitleAutoDownload.checked,
    convertVttToSrt: els.convertVttToSrt.checked,
    embedSubtitles: els.embedSubtitles.checked,
  };

  chrome.storage.sync.set(settings, () => {
    showToast("Settings saved");
  });
});

// Reset
els.resetBtn.addEventListener("click", () => {
  chrome.storage.sync.set(DEFAULTS, () => {
    els.defaultQuality.value = DEFAULTS.defaultQuality;
    els.filenameTemplate.value = DEFAULTS.filenameTemplate;
    els.maxConcurrent.value = DEFAULTS.maxConcurrent;
    els.outputFormat.value = DEFAULTS.outputFormat;
    els.remuxEngine.value = DEFAULTS.remuxEngine;
    els.ffmpegPath.value = DEFAULTS.ffmpegPath;
    els.bandwidthLimit.value = 0;
    els.autoScan.checked = DEFAULTS.autoScan;
    els.notifications.checked = DEFAULTS.notifications;
    els.subtitleAutoDownload.checked = DEFAULTS.subtitleAutoDownload;
    els.convertVttToSrt.checked = DEFAULTS.convertVttToSrt;
    els.embedSubtitles.checked = DEFAULTS.embedSubtitles;
    updatePreview();
    updateEngineUI();
    showToast("Reset to defaults");
  });
});

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden", "error");
  setTimeout(() => els.toast.classList.add("hidden"), 2000);
}
