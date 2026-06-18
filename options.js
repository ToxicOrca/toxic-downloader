// Toxic Downloader - Options Page

const DEFAULTS = {
  defaultQuality: "best",
  filenameTemplate: "",
  maxConcurrent: 3,
  outputFormat: "mp4",
  bandwidthLimit: 0,
  autoScan: false,
  notifications: true,
  subtitleAutoDownload: false,
};

const els = {
  defaultQuality: document.getElementById("defaultQuality"),
  filenameTemplate: document.getElementById("filenameTemplate"),
  maxConcurrent: document.getElementById("maxConcurrent"),
  outputFormat: document.getElementById("outputFormat"),
  bandwidthLimit: document.getElementById("bandwidthLimit"),
  autoScan: document.getElementById("autoScan"),
  notifications: document.getElementById("notifications"),
  subtitleAutoDownload: document.getElementById("subtitleAutoDownload"),
  templatePreview: document.getElementById("templatePreview"),
  saveBtn: document.getElementById("saveBtn"),
  resetBtn: document.getElementById("resetBtn"),
  toast: document.getElementById("toast"),
};

// Load settings
chrome.storage.sync.get(DEFAULTS, (settings) => {
  els.defaultQuality.value = settings.defaultQuality;
  els.filenameTemplate.value = settings.filenameTemplate;
  els.maxConcurrent.value = settings.maxConcurrent;
  els.outputFormat.value = settings.outputFormat;
  els.bandwidthLimit.value = settings.bandwidthLimit ? settings.bandwidthLimit / 1048576 : 0; // stored as bytes, displayed as MB
  els.autoScan.checked = settings.autoScan;
  els.notifications.checked = settings.notifications;
  els.subtitleAutoDownload.checked = settings.subtitleAutoDownload;
  updatePreview();
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
    bandwidthLimit: Math.max(0, parseFloat(els.bandwidthLimit.value) || 0) * 1048576, // MB to bytes
    autoScan: els.autoScan.checked,
    notifications: els.notifications.checked,
    subtitleAutoDownload: els.subtitleAutoDownload.checked,
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
    els.bandwidthLimit.value = 0;
    els.autoScan.checked = DEFAULTS.autoScan;
    els.notifications.checked = DEFAULTS.notifications;
    els.subtitleAutoDownload.checked = DEFAULTS.subtitleAutoDownload;
    updatePreview();
    showToast("Reset to defaults");
  });
});

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden", "error");
  setTimeout(() => els.toast.classList.add("hidden"), 2000);
}
