// Toxic Downloader - Content Script

(function () {
  "use strict";

  // Guard against duplicate injection (extension reload while tab is open)
  if (window.__toxicDownloaderInjected) return;
  window.__toxicDownloaderInjected = true;

  const detectedVideos = [];
  const seenUrls = new Set();

  // Inject the network interceptor into the page context
  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("interceptor.js");
    script.onload = () => script.remove();
    script.onerror = () => script.remove(); // CSP may block it, DOM scan still works
    (document.head || document.documentElement).appendChild(script);
  } catch (_) {
    // CSP blocked injection - DOM scanning will still work
  }

  // Listen for messages from page context
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type === "TOXIC_VIDEO_DETECTED") {
      addVideo(event.data.payload);
    }
    if (event.data?.type === "TOXIC_SUBTITLE_DETECTED") {
      addSubtitle(event.data.payload.url);
    }
    // HLS progress updates from background
    if (event.data?.type === "TOXIC_HLS_PROGRESS") {
      chrome.runtime.sendMessage({
        action: "hlsProgress",
        id: event.data.dlId,
        progress: event.data.progress,
      });
    }
    // Page context grabbed cookies, forward to background for fetching
    if (event.data?.type === "TOXIC_HLS_READY") {
      chrome.runtime.sendMessage({
        action: "hlsStart",
        dlId: event.data.dlId,
        url: event.data.url,
        filename: event.data.filename,
        cookies: event.data.cookies,
        referer: event.data.referer,
        origin: event.data.origin,
        selectedQuality: event.data.selectedQuality,
      });
    }
  });

  // Get all possible site brand names to strip from titles
  function getSiteNames() {
    const names = new Set();

    // og:site_name
    const ogSite = document.querySelector('meta[property="og:site_name"]');
    if (ogSite?.content?.trim()) names.add(ogSite.content.trim());

    // application-name
    const appName = document.querySelector('meta[name="application-name"]');
    if (appName?.content?.trim()) names.add(appName.content.trim());

    // Domain variations (e.g., "fmovies.to" -> "fmovies", "FMovies")
    const host = window.location.hostname.replace(/^www\./, "");
    const domainParts = host.split(".");
    const domainName = domainParts[0];
    names.add(domainName);
    names.add(domainName.charAt(0).toUpperCase() + domainName.slice(1));
    names.add(domainName.toUpperCase());
    // Full domain
    names.add(host);

    return [...names].filter(n => n.length > 1);
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Parse title information from the page
  function parsePageTitle() {
    const url = window.location.href;
    const title = document.title || "";

    let showName = null;
    let season = null;
    let episode = null;
    let episodeName = null;
    let movieName = null;
    let isShow = false;

    const sePatterns = [
      /[Ss](\d{1,2})\s*[Ee](\d{1,2})/,
      /[\/.-]s(\d{1,2})e(\d{1,2})/i,
      /(\d{1,2})x(\d{1,2})/,
    ];

    for (const pat of sePatterns) {
      const m = url.match(pat) || title.match(pat);
      if (m) {
        season = parseInt(m[1], 10);
        episode = parseInt(m[2], 10);
        isShow = true;
        break;
      }
    }

    if (!season || !episode) {
      const urlPathPatterns = [
        /season[_\/\-]?(\d{1,2})[_\/\-]?episode[_\/\-]?(\d{1,3})/i,
        /\/(\d{1,2})\/(\d{1,3})(?:\/|$)/,
      ];
      for (const pat of urlPathPatterns) {
        const m = url.match(pat);
        if (m) {
          season = parseInt(m[1], 10);
          episode = parseInt(m[2], 10);
          isShow = true;
          break;
        }
      }
    }

    const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of jsonLdScripts) {
      try {
        const data = JSON.parse(s.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item["@type"] === "TVEpisode" || item["@type"] === "Episode") {
            isShow = true;
            showName = item.partOfSeries?.name || item.partOfTVSeries?.name;
            if (!episodeName && item.name) episodeName = item.name;
            if (item.episodeNumber != null) episode = parseInt(item.episodeNumber, 10);
            if (item.partOfSeason?.seasonNumber != null)
              season = parseInt(item.partOfSeason.seasonNumber, 10);
          } else if (item["@type"] === "TVSeries") {
            isShow = true;
            if (!showName) showName = item.name;
          } else if (item["@type"] === "Movie") {
            movieName = item.name;
          } else if (item["@type"] === "VideoObject") {
            if (!movieName && !showName) movieName = item.name;
          }
        }
      } catch (_) {}
    }

    if (season == null || episode == null) {
      const textSources = document.querySelectorAll(
        'h1, h2, h3, h4, .breadcrumb, [class*="breadcrumb"], ' +
        '[class*="season"], [class*="episode"], ' +
        '[class*="info"], [class*="detail"], [class*="meta"], ' +
        'select, option[selected], [class*="active"], ' +
        '[class*="current"], a.active, li.active, ' +
        'span, p, .subtitle, [class*="subtitle"]'
      );

      const allTexts = [];
      textSources.forEach(el => {
        const t = el.textContent?.trim();
        if (t && t.length < 200) allTexts.push(t);
      });
      allTexts.push(title);
      allTexts.push(decodeURIComponent(url));
      const combinedText = allTexts.join(" | ");

      if (season == null) {
        for (const pat of [/season\s*[:\-#]?\s*(\d{1,2})/i, /\bS(\d{1,2})\b/]) {
          const m = combinedText.match(pat);
          if (m) { season = parseInt(m[1], 10); isShow = true; break; }
        }
      }

      if (episode == null) {
        for (const pat of [/episode\s*[:\-#]?\s*(\d{1,3})/i, /ep(?:isode)?\.?\s*(\d{1,3})\b/i, /\bE(\d{1,3})\b/]) {
          const m = combinedText.match(pat);
          if (m) { episode = parseInt(m[1], 10); isShow = true; break; }
        }
      }
    }

    if (season == null || episode == null) {
      const selects = document.querySelectorAll("select");
      selects.forEach(sel => {
        const selected = sel.options?.[sel.selectedIndex];
        if (!selected) return;
        const text = (selected.textContent + " " + selected.value).toLowerCase();
        if (season == null && /season/i.test(sel.className + sel.id + sel.name)) {
          const m = text.match(/(\d{1,2})/);
          if (m) { season = parseInt(m[1], 10); isShow = true; }
        }
        if (episode == null && /episode/i.test(sel.className + sel.id + sel.name)) {
          const m = text.match(/(\d{1,3})/);
          if (m) { episode = parseInt(m[1], 10); isShow = true; }
        }
      });
    }

    if (season == null || episode == null) {
      const headings = document.querySelectorAll("h1, h2, h3, h4");
      for (const h of headings) {
        const text = h.textContent;
        for (const pat of sePatterns) {
          const m = text.match(pat);
          if (m) {
            if (season == null) season = parseInt(m[1], 10);
            if (episode == null) episode = parseInt(m[2], 10);
            isShow = true;
            if (!showName) showName = text.replace(pat, "").replace(/[-:_.\s]+$/, "").trim();
            break;
          }
        }
        if (season != null && episode != null) break;
      }
    }

    // --- Get show/movie name from multiple sources, strip site branding ---

    // Collect candidate names from various sources
    const nameCandidates = [];

    // Source 1: og:title (usually cleanest)
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle?.content?.trim()) nameCandidates.push(ogTitle.content.trim());

    // Source 2: twitter:title
    const twTitle = document.querySelector('meta[name="twitter:title"]');
    if (twTitle?.content?.trim()) nameCandidates.push(twTitle.content.trim());

    // Source 3: h1 elements
    document.querySelectorAll("h1").forEach(el => {
      const t = el.textContent.trim();
      if (t.length > 1 && t.length < 120) nameCandidates.push(t);
    });

    // Source 4: elements with title-like classes
    const titleSelectors = [".video-title", ".movie-title", ".show-title", ".media-title",
      '[class*="player-title"]', '[class*="watch-title"]', '[data-testid="title"]'];
    for (const sel of titleSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim().length > 1 && el.textContent.trim().length < 120) {
        nameCandidates.push(el.textContent.trim());
      }
    }

    // Source 5: page title (last resort, most likely to have site name)
    nameCandidates.push(title);

    // Get all site brand names to strip
    const siteNames = getSiteNames();

    function cleanTitle(raw) {
      let cleaned = raw
        // Strip season/episode info
        .replace(/\s*[-:]?\s*season\s*\d+/i, "")
        .replace(/\s*[-:]?\s*episode\s*\d+.*/i, "")
        .replace(/\s*[Ss]\d{1,2}\s*[Ee]\d{1,2}.*/g, "")
        // Strip common junk phrases
        .replace(/\s*[-|:–—]\s*(Watch|Stream|Online|Free|HD|Full|Movie|Series|Download|Streaming).*$/i, "")
        .replace(/^(Watch|Stream|Download)\s+/i, "");

      // Strip all detected site names (from end and start)
      for (const name of siteNames) {
        const esc = escapeRegex(name);
        cleaned = cleaned
          .replace(new RegExp("\\s*[-|:–—·]\\s*" + esc + "\\s*$", "i"), "")
          .replace(new RegExp("^\\s*" + esc + "\\s*[-|:–—·]\\s*", "i"), "")
          .replace(new RegExp("\\s+on\\s+" + esc + "\\s*$", "i"), "")
          .replace(new RegExp("\\s*\\|\\s*" + esc + "\\s*$", "i"), "")
          .replace(new RegExp("^\\s*" + esc + "\\s*\\|\\s*", "i"), "");
      }

      // Strip trailing separators and bare domains
      cleaned = cleaned
        .replace(/\s*[-|:–—·]\s*\S+\.\w{2,4}\s*$/i, "")
        .replace(/\s*[-|:–—·]\s*$/g, "")
        .trim();

      return cleaned;
    }

    // Clean each candidate and pick the best one
    let bestName = null;
    for (const raw of nameCandidates) {
      const cleaned = cleanTitle(raw);
      if (cleaned.length < 2) continue;

      if (!bestName) {
        bestName = cleaned;
      } else if (cleaned.length <= bestName.length && cleaned.length >= 2) {
        // Prefer shorter clean names (less likely to have junk)
        bestName = cleaned;
      }
    }

    if (bestName && !showName && !movieName) {
      if (isShow) showName = bestName; else movieName = bestName;
    }

    // --- Try to extract episode name ---
    if (isShow && !episodeName) {
      // Check page title: patterns like "ShowName S01E03 - Episode Name" or "ShowName: Episode Name"
      const siteNames = getSiteNames();
      let cleanedTitle = title;
      for (const name of siteNames) {
        const esc = escapeRegex(name);
        cleanedTitle = cleanedTitle
          .replace(new RegExp("\\s*[-|:–—·]\\s*" + esc + "\\s*$", "i"), "")
          .replace(new RegExp("^\\s*" + esc + "\\s*[-|:–—·]\\s*", "i"), "")
          .replace(new RegExp("\\s*\\|\\s*" + esc + "\\s*$", "i"), "");
      }
      cleanedTitle = cleanedTitle.replace(/\s*[-|:]\s*(Watch|Stream|Online|Free|HD|Full).*$/i, "").trim();

      // Try to find episode name after S01E03 pattern
      const seMatch = cleanedTitle.match(/[Ss]\d{1,2}\s*[Ee]\d{1,2}\s*[-:.\s]+\s*(.+)$/);
      if (seMatch && seMatch[1].trim().length > 1) {
        episodeName = seMatch[1].trim();
      }

      // Try to find it after "Episode X" pattern
      if (!episodeName) {
        const epMatch = cleanedTitle.match(/[Ee]pisode\s*\d+\s*[-:.\s]+\s*(.+)$/);
        if (epMatch && epMatch[1].trim().length > 1) {
          episodeName = epMatch[1].trim();
        }
      }

      // Try heading elements with episode-related classes
      if (!episodeName) {
        const epSelectors = ['[class*="episode-name"]', '[class*="episode-title"]', '[class*="ep-title"]', '[class*="ep-name"]'];
        for (const sel of epSelectors) {
          const el = document.querySelector(sel);
          if (el?.textContent?.trim().length > 1 && el.textContent.trim().length < 100) {
            episodeName = el.textContent.trim();
            break;
          }
        }
      }

      // If bestName looks like it contains both show and episode name, try to split
      if (!episodeName && bestName && showName && bestName.length > showName.length + 3) {
        const remainder = bestName.replace(showName, "").replace(/^\s*[-:–—·]\s*/, "").trim();
        if (remainder.length > 1) {
          episodeName = remainder;
        }
      }
    }

    // Clean episode name - strip show name if it got included
    if (episodeName && showName) {
      episodeName = episodeName.replace(new RegExp("^" + escapeRegex(showName) + "\\s*[-:–—]\\s*", "i"), "").trim();
      // Don't use if it's the same as show name
      if (episodeName.toLowerCase() === showName.toLowerCase()) episodeName = null;
    }

    if (isShow && episode != null && season == null) season = 1;

    let filename;
    if (isShow && showName && season != null && episode != null) {
      const s = String(season).padStart(2, "0");
      const e = String(episode).padStart(2, "0");
      const epSuffix = episodeName ? "_" + sanitizeFilename(episodeName) : "";
      filename = `${sanitizeFilename(showName)}_S${s}E${e}${epSuffix}`;
    } else if (isShow && showName) {
      filename = sanitizeFilename(showName);
    } else if (movieName) {
      filename = sanitizeFilename(movieName);
    } else {
      filename = sanitizeFilename(title) || "video";
    }

    return { showName, movieName, season, episode, episodeName, isShow, filename };
  }

  function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]+/g, "").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").substring(0, 120);
  }

  function getQualityFromUrl(url) {
    // Match resolution only when it looks intentional (preceded by separator or path boundary, followed by p or separator)
    const m = url.match(/[\/._\-=](2160|1080|720|480|360|240)p(?:[\/._\-?&]|$)/i);
    if (m) return m[1] + "p";
    // Also check for explicit labels
    if (/[\/._\-=]4k[\/._\-?&]|[\/._\-=]uhd[\/._\-?&]/i.test(url)) return "2160p";
    return null;
  }

  function getFileExtension(url) {
    try {
      const ext = new URL(url).pathname.split(".").pop().toLowerCase().split("?")[0];
      if (["mp4", "mkv", "webm", "m3u8", "mpd", "ts", "m4s", "avi", "flv"].includes(ext)) return ext;
    } catch (_) {}
    return null;
  }

  function classifyVideo(url) {
    const lower = url.toLowerCase();
    if (/trailer|preview|promo|teaser|sample|clip|recap|behind.?the.?scenes/i.test(lower)) return "trailer";
    if (/doubleclick|googlesyndication|advertisement|adserver|ad[_\-]?break|preroll|midroll/i.test(lower)) return "ad";
    if (/\/seg-\d+|\/segment\d+/i.test(lower) && !/master|index|playlist/i.test(lower)) return "segment";
    if (/\.ts$/i.test(lower) && !/master|index|playlist/i.test(lower)) return "segment";
    // YouTube URLs use signed tokens and separate audio/video — not directly downloadable
    if (/googlevideo\.com|youtube\.com\/videoplayback/i.test(lower)) return "unsupported";
    return "content";
  }

  function isInPreviewContainer(el) {
    let node = el;
    for (let i = 0; i < 8 && node && node !== document.body; i++) {
      const combined = ((node.className || "").toString() + " " + (node.id || "")).toLowerCase();
      if (/preview|trailer|teaser|promo|hero|banner|billboard|featured|spotlight|card|thumbnail/i.test(combined)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function getPageThumbnail() {
    // Try og:image, twitter:image, schema.org thumbnailUrl
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage?.content) return ogImage.content;
    const twImage = document.querySelector('meta[name="twitter:image"]');
    if (twImage?.content) return twImage.content;
    const schemaThumb = document.querySelector('meta[itemprop="thumbnailUrl"]');
    if (schemaThumb?.content) return schemaThumb.content;
    // Try video poster attribute
    const video = document.querySelector("video[poster]");
    if (video?.poster) return video.poster;
    return null;
  }

  function addVideo(payload) {
    const { url, type, duration, inPreview } = payload;
    const normalized = url.split("?")[0];
    if (seenUrls.has(normalized)) return;

    const classification = classifyVideo(url);
    if (classification === "ad" || classification === "segment" || classification === "unsupported") return;

    seenUrls.add(normalized);

    const quality = getQualityFromUrl(url);
    const ext = getFileExtension(url) || type;
    const pageInfo = parsePageTitle();
    const isTrailer = classification === "trailer" || inPreview === true;

    const thumbnail = getPageThumbnail();

    const video = {
      url, quality, type: ext,
      filename: isTrailer ? pageInfo.filename + "_trailer" : pageInfo.filename,
      isShow: pageInfo.isShow, showName: pageInfo.showName,
      movieName: pageInfo.movieName, season: pageInfo.season,
      episode: pageInfo.episode, isTrailer, duration: duration || null,
      thumbnail,
    };

    detectedVideos.push(video);
    chrome.runtime.sendMessage({ action: "videoFound", video });
  }

  // --- Subtitle Detection ---
  const seenSubtitles = new Set();

  function addSubtitle(url, trackLang, trackLabel) {
    if (seenSubtitles.has(url)) return;
    seenSubtitles.add(url);

    let lang = "unknown";

    // 1. Use track element's srclang if provided
    if (trackLang && trackLang.length >= 2) {
      lang = trackLang.toLowerCase();
    }
    // 2. Use track label if it contains a language name
    else if (trackLabel) {
      const labelLower = trackLabel.toLowerCase();
      const langNames = {
        "english": "en", "spanish": "es", "french": "fr", "german": "de", "portuguese": "pt",
        "italian": "it", "japanese": "ja", "korean": "ko", "chinese": "zh", "arabic": "ar",
        "russian": "ru", "hindi": "hi", "dutch": "nl", "swedish": "sv", "danish": "da",
        "norwegian": "no", "finnish": "fi", "polish": "pl", "turkish": "tr", "thai": "th",
        "vietnamese": "vi", "indonesian": "id", "malay": "ms", "romanian": "ro", "hungarian": "hu",
        "czech": "cs", "greek": "el", "hebrew": "he", "ukrainian": "uk", "bulgarian": "bg",
        "croatian": "hr", "slovak": "sk", "slovenian": "sl", "serbian": "sr",
      };
      for (const [name, code] of Object.entries(langNames)) {
        if (labelLower.includes(name)) { lang = code; break; }
      }
    }
    // 3. Try URL patterns
    if (lang === "unknown") {
      // Match language codes in URL path or query params
      const langMatch = url.match(/[\/._\-=](en|eng|english|es|spa|spanish|fr|fra|french|de|deu|german|pt|por|it|ita|ja|jpn|ko|kor|zh|zho|ar|ara|ru|rus|hi|hin|nl|nld|sv|swe|da|dan|no|nor|fi|fin|pl|pol|tr|tur|th|tha|vi|vie)(?:[\/._\-?&=]|$)/i);
      if (langMatch) {
        const found = langMatch[1].toLowerCase();
        // Map full names to codes
        const map = { english: "en", spanish: "es", french: "fr", german: "de", portuguese: "pt", italian: "it", japanese: "ja", korean: "ko", chinese: "zh", arabic: "ar", russian: "ru" };
        lang = map[found] || found.substring(0, 2);
      }
    }
    // 4. If page is in English and only one subtitle, assume English
    if (lang === "unknown") {
      const pageLang = document.documentElement.lang || navigator.language || "";
      if (pageLang.startsWith("en")) lang = "en";
    }

    const ext = url.match(/\.(vtt|srt|ass|ssa|sub)(\?|$)/i);
    const type = ext ? ext[1].toLowerCase() : "vtt";

    chrome.runtime.sendMessage({
      action: "subtitleFound",
      subtitle: { url, lang, type },
    });
  }

  function scanSubtitles() {
    // Find <track> elements (subtitle/caption tracks in video players)
    document.querySelectorAll("track").forEach(track => {
      if (track.src && track.src.startsWith("http")) {
        addSubtitle(track.src, track.srclang || "", track.label || "");
      }
    });

    // Find subtitle links in the page
    document.querySelectorAll('a[href*=".vtt"], a[href*=".srt"]').forEach(a => {
      if (a.href.startsWith("http")) addSubtitle(a.href, "", a.textContent || "");
    });
  }

  function reclassifyPreviews() {
    const hasStream = detectedVideos.some(v => !v.isTrailer && (v.type === "m3u8" || v.type === "mpd"));
    if (!hasStream) return;

    let changed = false;
    for (const video of detectedVideos) {
      if (video.isTrailer || video.type === "m3u8" || video.type === "mpd") continue;
      // Only mark as trailer if we KNOW it's short (< 5 min)
      // Don't flag unknown-duration mp4s - they might be the actual content
      const isShort = video.duration != null && video.duration < 300;
      if (isShort) {
        video.isTrailer = true;
        video.filename = video.filename.replace(/_trailer$/, "") + "_trailer";
        changed = true;
      }
    }
    if (changed) chrome.runtime.sendMessage({ action: "videosUpdated", videos: detectedVideos });
  }

  function scanDOM() {
    const videos = document.querySelectorAll("video");
    videos.forEach((v) => {
      const src = v.currentSrc || v.src;
      if (src && src.startsWith("http")) {
        const duration = (v.duration && isFinite(v.duration)) ? v.duration : null;
        addVideo({ url: src, type: "mp4", duration, inPreview: isInPreviewContainer(v) });
      }
    });

    document.querySelectorAll("video source, source[type*='video']").forEach((s) => {
      if (s.src && s.src.startsWith("http")) {
        const type = s.type ? s.type.split("/")[1] : "mp4";
        const pv = s.closest("video");
        const duration = (pv?.duration && isFinite(pv.duration)) ? pv.duration : null;
        addVideo({ url: s.src, type, duration, inPreview: pv ? isInPreviewContainer(pv) : false });
      }
    });

    document.querySelectorAll("embed[type*='video'], object[type*='video']").forEach((e) => {
      const src = e.data || e.src;
      if (src && src.startsWith("http")) addVideo({ url: src, type: "mp4" });
    });

    reclassifyPreviews();
    scanSubtitles();
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "VIDEO") {
          if (node.src) addVideo({ url: node.src, type: "mp4" });
          if (node.currentSrc) addVideo({ url: node.currentSrc, type: "mp4" });
        }
        node.querySelectorAll?.("video").forEach((v) => {
          if (v.src) addVideo({ url: v.src, type: "mp4" });
        });
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // --- Handle HLS download request ---
  // Inject hls-downloader.js into page context (loaded via src= to bypass CSP)
  // then fire a custom event with the download params
  let hlsInjected = false;

  function ensureHLSDownloader() {
    if (hlsInjected) return Promise.resolve();
    return new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("hls-downloader.js");
      s.onload = () => { hlsInjected = true; s.remove(); resolve(); };
      s.onerror = () => { s.remove(); resolve(); };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  async function startHLSDownload(url, filename, dlId, selectedQuality) {
    await ensureHLSDownloader();
    window.dispatchEvent(new CustomEvent("__toxic_hls_start", {
      detail: { url, filename, dlId, selectedQuality }
    }));
  }

  // --- Receive HLS segment data from background and save as blob ---
  const hlsBuffers = {}; // dlId -> array of ArrayBuffers

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // Save subtitle as a separate file with Jellyfin/Plex compatible naming
  // Convention: VideoName.lang.srt (e.g., ShowName_S01E03.en.srt)
  function saveSeparateSubtitle(videoFilename, srtText, lang) {
    const baseName = videoFilename.replace(/\.[^.]+$/, ""); // strip extension
    const safeLang = (lang || "en").replace(/[^a-zA-Z]/g, "").substring(0, 3) || "en";
    const subFilename = baseName + "." + safeLang + ".srt";
    const subBlob = new Blob([srtText], { type: "application/x-subrip" });
    const subUrl = URL.createObjectURL(subBlob);
    const a = document.createElement("a");
    a.href = subUrl;
    a.download = subFilename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(subUrl), 60000);
  }

  function triggerSave(blob, filename, remuxNote, dlId) {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    if (remuxNote) {
      chrome.runtime.sendMessage({
        action: "hlsProgress",
        id: dlId,
        progress: { status: "done", percent: 100, text: "Saved as .ts (MP4 remux failed — file plays in VLC/mpv)", downloadedBytes: blob.size },
      });
    }

    setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
  }

  // Listen for messages
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "clearState") {
      // SPA navigation - clear all detected videos and subtitles
      detectedVideos.length = 0;
      seenUrls.clear();
      seenSubtitles.clear();
      sendResponse({ ok: true });
    } else if (msg.action === "scan") {
      scanDOM();
      sendResponse({ videos: detectedVideos });
    } else if (msg.action === "getVideos") {
      sendResponse({ videos: detectedVideos });
    } else if (msg.action === "downloadHLS") {
      startHLSDownload(msg.url, msg.filename, msg.dlId, msg.selectedQuality).then(() => {
        sendResponse({ started: true });
      });
      return true;
    } else if (msg.action === "fetchSubtitle") {
      // Fetch subtitle from page context (has cookies)
      fetch(msg.url, { credentials: "include" })
        .then(r => r.ok ? r.text() : null)
        .then(text => sendResponse({ text }))
        .catch(() => sendResponse({ text: null }));
      return true;
    } else if (msg.action === "hlsSaveRaw") {
      // Save buffered data directly as-is (already processed by ffmpeg)
      const bufs = hlsBuffers[msg.dlId] || [];
      const blob = new Blob(bufs, { type: "video/mp4" });
      triggerSave(blob, msg.filename, null, msg.dlId);
      delete hlsBuffers[msg.dlId];
      sendResponse({ ok: true });
    } else if (msg.action === "hlsClearBuffers") {
      delete hlsBuffers[msg.dlId];
      sendResponse({ ok: true });
    } else if (msg.action === "hlsSegmentData") {
      // Receive segment data chunks from background
      if (!hlsBuffers[msg.dlId]) hlsBuffers[msg.dlId] = [];
      for (const b64 of msg.chunks) {
        hlsBuffers[msg.dlId].push(base64ToArrayBuffer(b64));
      }
      sendResponse({ ok: true });
    } else if (msg.action === "hlsSave") {
      // All segments received - combine and optionally remux
      const bufs = hlsBuffers[msg.dlId] || [];
      let blob;
      let filename = msg.filename;
      const wantsTS = filename.endsWith(".ts");

      let remuxNote = "";

      // Determine content type and total size
      let totalSize = 0;
      for (const b of bufs) totalSize += b.byteLength;

      // Detect what the segments actually are
      const firstBytes = bufs.length > 0 ? new Uint8Array(bufs[0].slice(0, 8)) : null;
      const isTS = firstBytes && firstBytes[0] === 0x47; // TS sync byte
      const firstBoxType = firstBytes ? String.fromCharCode(firstBytes[4], firstBytes[5], firstBytes[6], firstBytes[7]) : "";
      const isMP4Fragments = firstBytes && (firstBoxType === "ftyp" || firstBoxType === "styp" || firstBoxType === "moof" || firstBoxType === "sidx" || firstBoxType === "moov");

      const hasSubData = msg.subtitleData && msg.subtitleData.text && msg.subtitleData.text.length > 0;
      const hasEmbedder = typeof ToxicSubtitleEmbed !== "undefined";
      let isRealMP4 = false; // true if blob has a proper moov box

      function reportEmbed(text) {
        chrome.runtime.sendMessage({ action: "hlsProgress", id: msg.dlId, progress: { status: "done", percent: 100, text: text } });
        try { chrome.storage.local.set({ lastEmbedResult: text }); } catch (_) {}
      }

      if (wantsTS) {
        blob = new Blob(bufs, { type: "video/mp2t" });
      } else if (isMP4Fragments) {
        // fMP4 segments — concatenate directly (already valid MP4)
        blob = new Blob(bufs, { type: "video/mp4" });
        isRealMP4 = true;
      } else if (isTS && typeof ToxicRemuxer !== "undefined" && totalSize < 300 * 1024 * 1024) {
        // TS segments under 300MB — try remux to proper MP4
        try {
          const tsData = new Uint8Array(totalSize);
          let offset = 0;
          for (const b of bufs) { tsData.set(new Uint8Array(b), offset); offset += b.byteLength; }
          const mp4Data = ToxicRemuxer.remux(tsData.buffer);
          if (mp4Data && mp4Data.length > 0) {
            blob = new Blob([mp4Data], { type: "video/mp4" });
            isRealMP4 = true;
          }
        } catch (_) {}

        if (!isRealMP4) {
          // Remux failed — save as .ts (honest extension)
          blob = new Blob(bufs, { type: "video/mp2t" });
          filename = filename.replace(/\.mp4$/, ".ts");
          remuxNote = "remux_failed";
        }
      } else if (isTS) {
        // TS segments too large to remux — save as .ts
        blob = new Blob(bufs, { type: "video/mp2t" });
        filename = filename.replace(/\.mp4$/, ".ts");
        remuxNote = "ts_too_large";
      } else {
        // Unknown format — save as-is
        blob = new Blob(bufs, { type: "video/mp4" });
      }

      // --- Subtitle handling ---
      if (hasSubData && isRealMP4 && hasEmbedder) {
        // Try embedding into real MP4
        const reader = new FileReader();
        reader.onload = function () {
          const originalSize = reader.result.byteLength;
          let embedWorked = false;
          let embedResult;
          try {
            const embedded = ToxicSubtitleEmbed.embed(reader.result, msg.subtitleData.text, msg.subtitleData.lang);
            const diagInfo = ToxicSubtitleEmbed.getLastInfo();
            if (embedded && embedded.length > originalSize) {
              blob = new Blob([embedded], { type: "video/mp4" });
              embedWorked = true;
              embedResult = "Subtitles embedded! " + diagInfo;
            } else {
              embedResult = "Embed failed: " + diagInfo;
            }
          } catch (e) {
            embedResult = "Embed error: " + e.message;
          }
          if (!embedWorked) {
            saveSeparateSubtitle(filename, msg.subtitleData.text, msg.subtitleData.lang);
            embedResult += " — saved as separate .srt file";
          }
          triggerSave(blob, filename, remuxNote, msg.dlId);
          reportEmbed(embedResult);
        };
        reader.onerror = function () {
          saveSeparateSubtitle(filename, msg.subtitleData.text, msg.subtitleData.lang);
          triggerSave(blob, filename, remuxNote, msg.dlId);
          reportEmbed("Read error — saved subtitle as separate .srt file");
        };
        reader.readAsArrayBuffer(blob);
      } else if (hasSubData) {
        // Can't embed (TS format or no moov) — save subtitle as separate file
        saveSeparateSubtitle(filename, msg.subtitleData.text, msg.subtitleData.lang);
        triggerSave(blob, filename, remuxNote, msg.dlId);
        reportEmbed("Saved as " + (filename.endsWith(".ts") ? ".ts" : ".mp4") + " + separate .srt subtitle");
      } else {
        triggerSave(blob, filename, remuxNote, msg.dlId);
        if (remuxNote) {
          reportEmbed(remuxNote === "ts_too_large"
            ? "File too large to remux (" + (totalSize / 1048576).toFixed(0) + "MB) — saved as .ts"
            : "Remux failed — saved as .ts");
        }
      }

      delete hlsBuffers[msg.dlId];
      sendResponse({ ok: true });
    }
    return true;
  });

  if (document.readyState === "complete") scanDOM();
  else window.addEventListener("load", scanDOM);
})();
