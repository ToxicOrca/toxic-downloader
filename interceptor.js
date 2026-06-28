// Toxic Downloader - Page-level Network Interceptor
// Injected into page context to intercept XHR/fetch for video URLs

(function () {
  "use strict";

  const VIDEO_EXTENSIONS = /\.(mp4|mkv|webm|m3u8|mpd|avi|flv|mov|m4v|ts)(\?|$)/i;
  const VIDEO_CONTENT_TYPES = /video\/|application\/x-mpegURL|application\/dash\+xml|application\/vnd\.apple\.mpegurl/i;
  const SUBTITLE_EXTENSIONS = /\.(vtt|srt|ass|ssa|sub)(\?|$)/i;
  const SUBTITLE_CONTENT_TYPES = /text\/vtt|application\/x-subrip/i;
  const NOT_SUBTITLE = /\.(html?|js|css|json|xml|php|asp)(\?|$)/i;

  function notifySubtitle(url) {
    window.postMessage({
      type: "TOXIC_SUBTITLE_DETECTED",
      payload: { url },
    }, location.origin);
  }

  function checkSubtitleUrl(url) {
    if (!url || typeof url !== "string") return false;
    if (!url.startsWith("http")) return false;
    if (NOT_SUBTITLE.test(url)) return false;
    return SUBTITLE_EXTENSIONS.test(url);
  }

  function notify(url, type, extra) {
    window.postMessage(
      {
        type: "TOXIC_VIDEO_DETECTED",
        payload: { url, type: type || "mp4", ...(extra || {}) },
      },
      location.origin
    );
  }

  const NOT_VIDEO = /\.(html?|php|asp|jsp|js|css|json|xml|txt|ico|svg|png|jpg|jpeg|gif|woff|ttf)(\?|$)/i;

  function checkUrl(url) {
    if (!url || typeof url !== "string") return false;
    if (!url.startsWith("http")) return false;
    if (/doubleclick|googlesyndication|adserver/i.test(url)) return false;
    if (NOT_VIDEO.test(url)) return false;
    return VIDEO_EXTENSIONS.test(url);
  }

  function getTypeFromUrl(url) {
    const m = url.match(/\.(mp4|mkv|webm|m3u8|mpd|avi|flv|mov|m4v|ts)(\?|$)/i);
    return m ? m[1].toLowerCase() : "mp4";
  }

  // Intercept XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._toxicUrl = url?.toString();
    return origOpen.apply(this, arguments);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("readystatechange", function () {
      if (this.readyState >= 2) {
        const url = this._toxicUrl;
        if (checkUrl(url)) {
          notify(url, getTypeFromUrl(url));
        }
        if (checkSubtitleUrl(url)) {
          notifySubtitle(url);
        }
        try {
          const ct = this.getResponseHeader?.("content-type");
          if (ct && VIDEO_CONTENT_TYPES.test(ct) && url && !NOT_VIDEO.test(url)) {
            notify(url, ct.includes("mpegURL") ? "m3u8" : "mp4");
          }
          if (ct && SUBTITLE_CONTENT_TYPES.test(ct) && url && !NOT_SUBTITLE.test(url)) {
            notifySubtitle(url);
          }
        } catch (_) {}
      }
    });
    return origSend.apply(this, arguments);
  };

  // Intercept fetch
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url;
    if (checkUrl(url)) {
      notify(url, getTypeFromUrl(url));
    }
    if (checkSubtitleUrl(url)) {
      notifySubtitle(url);
    }
    return origFetch.apply(this, arguments).then((response) => {
      const ct = response.headers?.get("content-type");
      if (ct && VIDEO_CONTENT_TYPES.test(ct) && url && !NOT_VIDEO.test(url)) {
        notify(url, ct.includes("mpegURL") ? "m3u8" : "mp4");
      }
      if (ct && SUBTITLE_CONTENT_TYPES.test(ct) && url && !NOT_SUBTITLE.test(url)) {
        notifySubtitle(url);
      }
      return response;
    });
  };

  // Intercept createElement to catch dynamic video/source elements
  const origCreateElement = document.createElement.bind(document);
  document.createElement = function (tagName) {
    const el = origCreateElement(tagName);
    if (tagName.toLowerCase() === "video" || tagName.toLowerCase() === "source") {
      const origSetAttr = el.setAttribute.bind(el);
      el.setAttribute = function (name, value) {
        if (name === "src" && checkUrl(value)) {
          notify(value, getTypeFromUrl(value));
        }
        return origSetAttr(name, value);
      };

      // Also watch the src property
      let _src = "";
      Object.defineProperty(el, "src", {
        get() { return _src; },
        set(val) {
          _src = val;
          if (checkUrl(val)) {
            notify(val, getTypeFromUrl(val));
          }
          origSetAttr("src", val);
        },
        configurable: true,
      });
    }
    return el;
  };
})();
