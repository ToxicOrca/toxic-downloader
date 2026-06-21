// Toxic Downloader - MP4 Subtitle Embedder
// Embeds SRT/text subtitle track into an MP4 file as tx3g (3GPP Timed Text)
// Returns { data: Uint8Array, info: string } or { data: null, info: string }

var ToxicSubtitleEmbed = (function () {
  "use strict";

  function embedSubtitles(mp4Data, srtText, lang) {
    var info = [];

    // Parse subtitles
    var cues = parseSRT(srtText);
    info.push(cues.length + " cues parsed");
    if (cues.length === 0) return { data: null, info: "No subtitle cues found in text (" + srtText.length + " chars)" };

    var mp4 = new Uint8Array(mp4Data);
    info.push("MP4 size: " + mp4.length);

    // Check if this is actually MPEG-TS data (starts with 0x47 sync byte) not MP4
    if (mp4[0] === 0x47 || (mp4[0] === 0x00 && mp4[1] === 0x00 && mp4[2] === 0x00 && mp4[3] !== 0x00 && mp4[4] !== 0x66 && mp4[4] !== 0x6D)) {
      // Check for TS sync bytes at 188-byte intervals
      if (mp4[0] === 0x47 && mp4.length > 188 && mp4[188] === 0x47) {
        return { data: null, info: "File is MPEG-TS data (not MP4) — cannot embed subtitles into TS. Use separate .srt file." };
      }
    }

    // Log first box types for debugging
    var boxLog = [];
    var scanPos = 0;
    for (var b = 0; b < 6 && scanPos + 8 <= mp4.length; b++) {
      var bSize = readU32(mp4, scanPos);
      if (bSize < 8 || bSize > mp4.length) { boxLog.push("invalid(" + bSize + ")"); break; }
      var bType = String.fromCharCode(mp4[scanPos + 4], mp4[scanPos + 5], mp4[scanPos + 6], mp4[scanPos + 7]);
      boxLog.push(bType + "(" + bSize + ")");
      scanPos += bSize;
    }
    info.push("Boxes: " + boxLog.join(" > "));

    // Find moov box
    var moovPos = findBox(mp4, 0, mp4.length, "moov");
    if (moovPos < 0) return { data: null, info: info.join("; ") + "; No moov box found — file may be concatenated TS segments" };

    var moovSize = readU32(mp4, moovPos);
    info.push("moov at " + moovPos + " size " + moovSize);

    // Read timescale and duration from mvhd
    var timescale = 1000;
    var duration = 0;
    var mvhdPos = findBox(mp4, moovPos + 8, moovPos + moovSize, "mvhd");
    if (mvhdPos >= 0) {
      var mvhdVer = mp4[mvhdPos + 8];
      if (mvhdVer === 0) {
        timescale = readU32(mp4, mvhdPos + 20);
        duration = readU32(mp4, mvhdPos + 24);
      } else {
        // Version 1: 8-byte fields
        timescale = readU32(mp4, mvhdPos + 28);
        duration = readU32(mp4, mvhdPos + 36); // only lower 32 bits
      }
      info.push("mvhd: timescale=" + timescale + " duration=" + duration + " ver=" + mvhdVer);
    } else {
      info.push("No mvhd found");
    }

    // Count existing tracks
    var trackCount = 0;
    var trakSearch = moovPos + 8;
    while (trakSearch < moovPos + moovSize) {
      var tpos = findBox(mp4, trakSearch, moovPos + moovSize, "trak");
      if (tpos < 0) break;
      trackCount++;
      trakSearch = tpos + readU32(mp4, tpos);
    }
    info.push(trackCount + " existing tracks");

    var subTrackId = trackCount + 1;

    // Build subtitle track
    var subDuration = cues[cues.length - 1].end;
    // Convert subtitle duration from ms to moov timescale
    var scaledDuration = Math.round(subDuration * timescale / 1000);
    if (duration === 0) duration = scaledDuration;

    var subtitleTrak = buildSubtitleTrak(cues, subTrackId, timescale, duration);
    info.push("Sub trak built: " + subtitleTrak.trak.length + " bytes, " + subtitleTrak.mdat.length + " bytes mdat");

    // Insert into MP4
    var result = insertIntoMoov(mp4, moovPos, moovSize, subtitleTrak, subTrackId + 1, mvhdPos);
    info.push("Result: " + result.length + " bytes (was " + mp4.length + ")");

    return { data: result, info: info.join("; ") };
  }

  function parseSRT(text) {
    if (!text || text.trim().length === 0) return [];

    // Normalize line endings
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    var blocks = text.split(/\n\n+/);
    var cues = [];

    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].trim().split("\n");
      if (lines.length < 2) continue;

      // Find the timestamp line
      var tsLine = -1;
      for (var j = 0; j < Math.min(lines.length, 3); j++) {
        if (lines[j].includes("-->")) { tsLine = j; break; }
      }
      if (tsLine < 0) continue;

      var parts = lines[tsLine].split("-->");
      if (parts.length < 2) continue;

      var startMs = parseTime(parts[0].trim());
      var endMs = parseTime(parts[1].trim().split(" ")[0]); // strip position info after timestamp
      if (startMs < 0 || endMs < 0 || endMs <= startMs) continue;

      var textContent = lines.slice(tsLine + 1).join("\n").trim();
      textContent = textContent.replace(/<[^>]+>/g, ""); // strip HTML tags
      if (textContent.length === 0) continue;

      cues.push({ start: startMs, end: endMs, text: textContent });
    }

    return cues;
  }

  function parseTime(ts) {
    var m = ts.match(/(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/);
    if (!m) return -1;
    var hours = parseInt(m[1] || "0", 10);
    var mins = parseInt(m[2], 10);
    var secs = parseInt(m[3], 10);
    var ms = parseInt((m[4] + "000").substring(0, 3), 10);
    return hours * 3600000 + mins * 60000 + secs * 1000 + ms;
  }

  function buildSubtitleTrak(cues, trackId, timescale, duration) {
    // Build all samples first (text content + gap samples)
    var samples = [];
    for (var i = 0; i < cues.length; i++) {
      // Text sample
      var textBytes = encodeUTF8(cues[i].text);
      var sampleData = new Uint8Array(2 + textBytes.length);
      sampleData[0] = (textBytes.length >> 8) & 0xFF;
      sampleData[1] = textBytes.length & 0xFF;
      sampleData.set(textBytes, 2);

      var startScaled = Math.round(cues[i].start * timescale / 1000);
      var endScaled = Math.round(cues[i].end * timescale / 1000);

      samples.push({ data: sampleData, duration: endScaled - startScaled });

      // Gap sample (empty) between this cue and next
      if (i + 1 < cues.length) {
        var nextStart = Math.round(cues[i + 1].start * timescale / 1000);
        var gap = nextStart - endScaled;
        if (gap > 0) {
          samples.push({ data: new Uint8Array([0, 0]), duration: gap });
        }
      }
    }

    // Leading gap if first cue doesn't start at 0
    var firstStart = Math.round(cues[0].start * timescale / 1000);
    if (firstStart > 0) {
      samples.unshift({ data: new Uint8Array([0, 0]), duration: firstStart });
    }

    // tkhd
    var tkhd = buildBox("tkhd", concatBytes(
      new Uint8Array([0, 0, 0, 3]), // version 0, flags: enabled + in-movie
      zeros(4), zeros(4), // creation/modification time
      uint32(trackId), zeros(4), // track ID, reserved
      uint32(duration), // duration
      zeros(8), // reserved
      uint16(0), uint16(0), // layer, alternate group
      uint16(0), uint16(0), // volume, reserved
      // Identity matrix
      uint32(0x00010000), zeros(4), zeros(4),
      zeros(4), uint32(0x00010000), zeros(4),
      zeros(4), zeros(4), uint32(0x40000000),
      zeros(4), zeros(4) // width, height
    ));

    // mdhd
    var mdhd = buildBox("mdhd", concatBytes(
      zeros(4), // version 0
      zeros(4), zeros(4), // creation/modification
      uint32(timescale),
      uint32(duration),
      uint16(0x55C4), uint16(0) // language: und
    ));

    // hdlr
    var hdlr = buildBox("hdlr", concatBytes(
      zeros(4), zeros(4),
      asciiBytes("sbtl"),
      zeros(12),
      asciiBytes("SubtitleHandler"), new Uint8Array([0])
    ));

    // tx3g sample entry
    var tx3gPayload = concatBytes(
      zeros(6), uint16(1), // reserved, data_ref_index
      uint32(0), // display flags
      new Uint8Array([1, 255]), // h-justify center, v-justify bottom
      zeros(4), // bg color
      uint16(0), uint16(0), uint16(0), uint16(0), // text box
      uint16(0), uint16(0), // startChar, endChar
      uint16(1), // font ID
      new Uint8Array([0, 18]), // style flags, font size
      new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]) // text color white
    );
    var ftab = buildBox("ftab", concatBytes(uint16(1), uint16(1), new Uint8Array([5]), asciiBytes("Serif")));
    var tx3g = buildBox("tx3g", concatBytes(tx3gPayload, ftab));

    var stsd = buildBox("stsd", concatBytes(zeros(4), uint32(1), tx3g));

    // stts - time to sample
    var sttsData = [];
    for (var i = 0; i < samples.length; i++) {
      sttsData.push(uint32(1));
      sttsData.push(uint32(samples[i].duration));
    }
    var stts = buildBox("stts", concatBytes(zeros(4), uint32(samples.length), concatAll(sttsData)));

    // stsz - sample sizes
    var stszData = [];
    for (var i = 0; i < samples.length; i++) {
      stszData.push(uint32(samples[i].data.length));
    }
    var stsz = buildBox("stsz", concatBytes(zeros(4), uint32(0), uint32(samples.length), concatAll(stszData)));

    // stsc - all samples in one chunk
    var stsc = buildBox("stsc", concatBytes(zeros(4), uint32(1), uint32(1), uint32(samples.length), uint32(1)));

    // stco - placeholder, will be patched
    var stco = buildBox("stco", concatBytes(zeros(4), uint32(1), uint32(0)));

    var stbl = buildBox("stbl", concatBytes(stsd, stts, stsc, stsz, stco));
    var nmhd = buildBox("nmhd", zeros(4));
    var dref = buildBox("dref", concatBytes(zeros(4), uint32(1), buildBox("url ", new Uint8Array([0, 0, 0, 1]))));
    var dinf = buildBox("dinf", dref);
    var minf = buildBox("minf", concatBytes(nmhd, dinf, stbl));
    var mdia = buildBox("mdia", concatBytes(mdhd, hdlr, minf));
    var trak = buildBox("trak", concatBytes(tkhd, mdia));

    // Build mdat with all sample data
    var allSampleData = concatAll(samples.map(function(s) { return s.data; }));
    var mdat = buildBox("mdat", allSampleData);

    return { trak: trak, mdat: mdat };
  }

  function insertIntoMoov(mp4, moovPos, moovSize, subData, nextTrackId, mvhdPos) {
    // Strategy: rebuild the moov box with the subtitle trak appended
    var oldMoovContent = mp4.subarray(moovPos + 8, moovPos + moovSize);
    var newMoovContent = concatBytes(oldMoovContent, subData.trak);
    var newMoov = buildBox("moov", newMoovContent);

    // Update mvhd next_track_id in the new moov
    var newMvhdPos = findBox(newMoov, 8, newMoov.length, "mvhd");
    if (newMvhdPos >= 0) {
      var ver = newMoov[newMvhdPos + 8];
      // next_track_id is at byte 96 (v0) or 108 (v1) from start of mvhd fullbox data
      var ntidOffset = newMvhdPos + 8 + (ver === 0 ? 96 : 108);
      if (ntidOffset + 4 <= newMoov.length) {
        writeU32(newMoov, ntidOffset, nextTrackId);
      }
    }

    // Assemble: [before moov] [new moov] [after moov] [subtitle mdat]
    var beforeMoov = mp4.subarray(0, moovPos);
    var afterMoov = mp4.subarray(moovPos + moovSize);

    var result = concatBytes(beforeMoov, newMoov, afterMoov, subData.mdat);

    // Patch stco in subtitle track to point to the subtitle mdat
    // The subtitle mdat starts at: beforeMoov.length + newMoov.length + afterMoov.length
    var mdatOffset = beforeMoov.length + newMoov.length + afterMoov.length + 8; // +8 for mdat box header

    // Find the last stco in the file (belongs to our subtitle track)
    var lastStco = -1;
    for (var i = result.length - 100; i >= beforeMoov.length; i--) {
      if (result[i] === 0x73 && result[i+1] === 0x74 && result[i+2] === 0x63 && result[i+3] === 0x6F) {
        lastStco = i - 4; // stco box starts 4 bytes before the type
        break;
      }
    }
    if (lastStco >= 0) {
      // stco structure: [size:4][type:4][version:4][count:4][offset:4]
      writeU32(result, lastStco + 16, mdatOffset);
    }

    return result;
  }

  // --- Box helpers ---

  function findBox(data, start, end, type) {
    var tc = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
    var pos = start;
    while (pos + 8 <= end) {
      var size = readU32(data, pos);
      if (size < 8 || pos + size > end) break;
      if (data[pos+4] === tc[0] && data[pos+5] === tc[1] && data[pos+6] === tc[2] && data[pos+7] === tc[3]) return pos;
      pos += size;
    }
    return -1;
  }

  function buildBox(type, payload) {
    var size = 8 + payload.length;
    var r = new Uint8Array(size);
    writeU32(r, 0, size);
    r[4] = type.charCodeAt(0); r[5] = type.charCodeAt(1);
    r[6] = type.charCodeAt(2); r[7] = type.charCodeAt(3);
    r.set(payload, 8);
    return r;
  }

  function readU32(d, o) { return ((d[o] << 24) | (d[o+1] << 16) | (d[o+2] << 8) | d[o+3]) >>> 0; }
  function writeU32(d, o, v) { d[o] = (v>>>24)&0xFF; d[o+1] = (v>>>16)&0xFF; d[o+2] = (v>>>8)&0xFF; d[o+3] = v&0xFF; }
  function uint32(v) { var a = new Uint8Array(4); writeU32(a, 0, v); return a; }
  function uint16(v) { return new Uint8Array([(v>>>8)&0xFF, v&0xFF]); }
  function zeros(n) { return new Uint8Array(n); }
  function asciiBytes(s) { var a = new Uint8Array(s.length); for(var i=0;i<s.length;i++) a[i]=s.charCodeAt(i); return a; }

  function encodeUTF8(text) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
    var a = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) a.push(c);
      else if (c < 0x800) { a.push(0xC0|(c>>6), 0x80|(c&0x3F)); }
      else { a.push(0xE0|(c>>12), 0x80|((c>>6)&0x3F), 0x80|(c&0x3F)); }
    }
    return new Uint8Array(a);
  }

  function concatBytes() {
    var total = 0;
    for (var i = 0; i < arguments.length; i++) if (arguments[i]) total += arguments[i].length;
    var r = new Uint8Array(total), off = 0;
    for (var i = 0; i < arguments.length; i++) { if (arguments[i]) { r.set(arguments[i], off); off += arguments[i].length; } }
    return r;
  }

  function concatAll(arr) {
    var total = 0;
    for (var i = 0; i < arr.length; i++) total += arr[i].length;
    var r = new Uint8Array(total), off = 0;
    for (var i = 0; i < arr.length; i++) { r.set(arr[i], off); off += arr[i].length; }
    return r;
  }

  return {
    embed: function(mp4Data, srtText, lang) {
      var result = embedSubtitles(mp4Data, srtText, lang || "und");
      // Store info for diagnostics
      this._lastInfo = result.info;
      return result.data;
    },
    getLastInfo: function() { return this._lastInfo || "No info"; }
  };
})();
