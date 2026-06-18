// Toxic Downloader - HLS Downloader (runs in page context)
// Grabs cookies/referer and posts them back to content script
// so background can do the actual fetching (no CORS restrictions)

window.addEventListener("__toxic_hls_start", function (e) {
  var url = e.detail.url;
  var filename = e.detail.filename;
  var dlId = e.detail.dlId;
  var selectedQuality = e.detail.selectedQuality || null;

  var cookies = document.cookie || "";
  var referer = location.href;
  var origin = location.origin;

  window.postMessage({
    type: "TOXIC_HLS_READY",
    dlId: dlId,
    url: url,
    filename: filename,
    cookies: cookies,
    referer: referer,
    origin: origin,
    selectedQuality: selectedQuality
  }, location.origin);
});
