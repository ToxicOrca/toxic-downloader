// Toxic Downloader - TS to MP4 Remuxer
// Demuxes MPEG-TS and remuxes into a fragmented MP4 container
// Handles H.264 video and AAC audio streams

var ToxicRemuxer = (function () {
  "use strict";

  // --- TS Demuxer ---

  function demuxTS(data) {
    var bytes = new Uint8Array(data);
    var videoTrack = { type: "video", codec: "avc1", samples: [], sps: null, pps: null };
    var audioTrack = { type: "audio", codec: "mp4a", samples: [], config: null, sampleRate: 0, channels: 0 };

    var pmtParsed = false;
    var videoPID = -1;
    var audioPID = -1;

    var videoPES = { data: [], size: 0, pts: 0, dts: 0 };
    var audioPES = { data: [], size: 0, pts: 0, dts: 0 };

    var pos = 0;
    // Find first sync byte
    while (pos < bytes.length && bytes[pos] !== 0x47) pos++;

    while (pos + 188 <= bytes.length) {
      if (bytes[pos] !== 0x47) { pos++; continue; }

      var pusi = (bytes[pos + 1] & 0x40) !== 0;
      var pid = ((bytes[pos + 1] & 0x1F) << 8) | bytes[pos + 2];
      var adaptation = (bytes[pos + 3] & 0x30) >> 4;

      var offset = 4;
      if (adaptation === 3 || adaptation === 2) {
        offset += 1 + bytes[pos + 4]; // skip adaptation field
      }

      if (adaptation === 1 || adaptation === 3) {
        var payload = bytes.subarray(pos + offset, pos + 188);

        if (pid === 0) {
          // PAT - find PMT PID
          if (pusi) payload = payload.subarray(1 + payload[0]);
          if (payload.length >= 12) {
            // PAT parsed - PMT discovery handled below via stream type detection
          }
        } else if (!pmtParsed && payload.length > 0) {
          // Try to parse as PMT
          if (pusi) {
            var ptrField = payload[0];
            var tablePayload = payload.subarray(1 + ptrField);
            if (tablePayload.length > 0 && tablePayload[0] === 0x02) {
              // This is a PMT
              var sectionLen = ((tablePayload[1] & 0x0F) << 8) | tablePayload[2];
              var pcrPID = ((tablePayload[8] & 0x1F) << 8) | tablePayload[9];
              var progInfoLen = ((tablePayload[10] & 0x0F) << 8) | tablePayload[11];
              var idx = 12 + progInfoLen;
              var endIdx = Math.min(3 + sectionLen - 4, tablePayload.length);
              while (idx + 5 <= endIdx) {
                var streamType = tablePayload[idx];
                var elemPID = ((tablePayload[idx + 1] & 0x1F) << 8) | tablePayload[idx + 2];
                var esInfoLen = ((tablePayload[idx + 3] & 0x0F) << 8) | tablePayload[idx + 4];
                if (streamType === 0x1B || streamType === 0x24) { // H.264 or H.265
                  videoPID = elemPID;
                } else if (streamType === 0x0F || streamType === 0x11) { // AAC
                  audioPID = elemPID;
                } else if (streamType === 0x03 || streamType === 0x04) { // MP3
                  audioPID = elemPID;
                }
                idx += 5 + esInfoLen;
              }
              pmtParsed = true;
            }
          }
        }

        if (pid === videoPID && videoPID > 0) {
          if (pusi) {
            if (videoPES.data.length > 0) {
              processVideoPES(videoPES, videoTrack);
            }
            var pesInfo = parsePESHeader(payload);
            videoPES = { data: [pesInfo.data], size: pesInfo.data.length, pts: pesInfo.pts, dts: pesInfo.dts };
          } else if (videoPES.data.length > 0) {
            videoPES.data.push(payload);
            videoPES.size += payload.length;
          }
        }

        if (pid === audioPID && audioPID > 0) {
          if (pusi) {
            if (audioPES.data.length > 0) {
              processAudioPES(audioPES, audioTrack);
            }
            var pesInfo2 = parsePESHeader(payload);
            audioPES = { data: [pesInfo2.data], size: pesInfo2.data.length, pts: pesInfo2.pts, dts: pesInfo2.dts };
          } else if (audioPES.data.length > 0) {
            audioPES.data.push(payload);
            audioPES.size += payload.length;
          }
        }
      }
      pos += 188;
    }

    // Flush remaining
    if (videoPES.data.length > 0) processVideoPES(videoPES, videoTrack);
    if (audioPES.data.length > 0) processAudioPES(audioPES, audioTrack);

    return { video: videoTrack, audio: audioTrack };
  }

  function parsePESHeader(data) {
    var pts = 0, dts = 0;
    var headerLen = 0;

    if (data.length >= 9 && data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x01) {
      var ptsDtsFlag = (data[7] & 0xC0) >> 6;
      headerLen = 9 + data[8];

      if (ptsDtsFlag >= 2 && data.length >= 14) {
        pts = ((data[9] & 0x0E) * 536870912) +
              ((data[10] & 0xFF) * 4194304) +
              ((data[11] & 0xFE) * 16384) +
              ((data[12] & 0xFF) * 128) +
              ((data[13] & 0xFE) >> 1);
      }
      if (ptsDtsFlag === 3 && data.length >= 19) {
        dts = ((data[14] & 0x0E) * 536870912) +
              ((data[15] & 0xFF) * 4194304) +
              ((data[16] & 0xFE) * 16384) +
              ((data[17] & 0xFF) * 128) +
              ((data[18] & 0xFE) >> 1);
      } else {
        dts = pts;
      }
    }

    return { data: data.subarray(headerLen), pts: pts, dts: dts };
  }

  function concatBuffers(arrays) {
    var totalLen = 0;
    for (var i = 0; i < arrays.length; i++) totalLen += arrays[i].length;
    var result = new Uint8Array(totalLen);
    var offset = 0;
    for (var i = 0; i < arrays.length; i++) {
      result.set(arrays[i], offset);
      offset += arrays[i].length;
    }
    return result;
  }

  function processVideoPES(pes, track) {
    var raw = concatBuffers(pes.data);
    var nalus = extractNALUs(raw);

    for (var i = 0; i < nalus.length; i++) {
      var nalu = nalus[i];
      var nalType = nalu[0] & 0x1F;

      if (nalType === 7) { // SPS
        track.sps = nalu;
      } else if (nalType === 8) { // PPS
        track.pps = nalu;
      }
    }

    // Filter to only video NALUs (not SPS/PPS for samples)
    var sampleNALUs = [];
    var sampleSize = 0;
    for (var i = 0; i < nalus.length; i++) {
      var nalType2 = nalus[i][0] & 0x1F;
      if (nalType2 === 1 || nalType2 === 5 || nalType2 === 6) { // Coded slice, IDR, SEI
        sampleNALUs.push(nalus[i]);
        sampleSize += 4 + nalus[i].length; // 4 bytes length prefix
      }
    }

    if (sampleSize > 0) {
      var sampleData = new Uint8Array(sampleSize);
      var off = 0;
      for (var i = 0; i < sampleNALUs.length; i++) {
        var n = sampleNALUs[i];
        sampleData[off] = (n.length >> 24) & 0xFF;
        sampleData[off + 1] = (n.length >> 16) & 0xFF;
        sampleData[off + 2] = (n.length >> 8) & 0xFF;
        sampleData[off + 3] = n.length & 0xFF;
        sampleData.set(n, off + 4);
        off += 4 + n.length;
      }

      var isKeyframe = false;
      for (var i = 0; i < nalus.length; i++) {
        if ((nalus[i][0] & 0x1F) === 5) { isKeyframe = true; break; }
      }

      track.samples.push({
        data: sampleData,
        size: sampleSize,
        pts: pes.pts,
        dts: pes.dts,
        isKeyframe: isKeyframe
      });
    }
  }

  function extractNALUs(data) {
    var nalus = [];
    var i = 0;
    var start = -1;

    while (i < data.length - 2) {
      if (data[i] === 0 && data[i + 1] === 0) {
        var zeroCount = 2;
        while (i + zeroCount < data.length && data[i + zeroCount] === 0) zeroCount++;
        if (i + zeroCount < data.length && data[i + zeroCount] === 1) {
          if (start >= 0) {
            nalus.push(data.subarray(start, i));
          }
          start = i + zeroCount + 1;
          i = start;
          continue;
        }
      }
      i++;
    }
    if (start >= 0 && start < data.length) {
      nalus.push(data.subarray(start));
    }
    return nalus;
  }

  function processAudioPES(pes, track) {
    var raw = concatBuffers(pes.data);
    // Parse ADTS frames
    var offset = 0;
    while (offset + 7 <= raw.length) {
      if (raw[offset] !== 0xFF || (raw[offset + 1] & 0xF0) !== 0xF0) {
        offset++;
        continue;
      }

      var headerSize = (raw[offset + 1] & 0x01) === 0 ? 9 : 7;
      var frameLength = ((raw[offset + 3] & 0x03) << 11) | (raw[offset + 4] << 3) | ((raw[offset + 5] & 0xE0) >> 5);

      if (frameLength <= headerSize || offset + frameLength > raw.length) break;

      if (!track.config) {
        var profile = ((raw[offset + 2] & 0xC0) >> 6) + 1;
        var samplingIndex = (raw[offset + 2] & 0x3C) >> 2;
        var channelConfig = ((raw[offset + 2] & 0x01) << 2) | ((raw[offset + 3] & 0xC0) >> 6);
        var sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
        track.sampleRate = sampleRates[samplingIndex] || 44100;
        track.channels = channelConfig || 2;
        // AudioSpecificConfig
        track.config = new Uint8Array([
          (profile << 3) | ((samplingIndex & 0x0E) >> 1),
          ((samplingIndex & 0x01) << 7) | (channelConfig << 3)
        ]);
      }

      var frameData = raw.subarray(offset + headerSize, offset + frameLength);
      track.samples.push({
        data: frameData,
        size: frameData.length,
        pts: pes.pts + (track.samples.length * 1024 * 90000 / track.sampleRate),
        dts: pes.pts + (track.samples.length * 1024 * 90000 / track.sampleRate),
        isKeyframe: true
      });

      offset += frameLength;
    }
  }

  // --- MP4 Muxer ---

  function box(type, payload) {
    var typeBytes = typeof type === "string" ? [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)] : type;
    var size = 8 + payload.length;
    var result = new Uint8Array(size);
    result[0] = (size >> 24) & 0xFF;
    result[1] = (size >> 16) & 0xFF;
    result[2] = (size >> 8) & 0xFF;
    result[3] = size & 0xFF;
    result[4] = typeBytes[0];
    result[5] = typeBytes[1];
    result[6] = typeBytes[2];
    result[7] = typeBytes[3];
    result.set(payload, 8);
    return result;
  }

  function concatArrays() {
    var arrays = [];
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i]) arrays.push(arguments[i]);
    }
    var totalLen = 0;
    for (var i = 0; i < arrays.length; i++) totalLen += arrays[i].length;
    var result = new Uint8Array(totalLen);
    var offset = 0;
    for (var i = 0; i < arrays.length; i++) {
      result.set(arrays[i], offset);
      offset += arrays[i].length;
    }
    return result;
  }

  function u32(v) { return new Uint8Array([(v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]); }
  function u16(v) { return new Uint8Array([(v >> 8) & 0xFF, v & 0xFF]); }

  function muxToMP4(tracks) {
    var video = tracks.video;
    var audio = tracks.audio;

    if (!video.sps || !video.pps || video.samples.length === 0) {
      return null; // Can't create MP4 without SPS/PPS
    }

    // Parse width/height from SPS NAL unit
    var width = 1920, height = 1080;
    try {
      var spsData = video.sps;
      if (spsData && spsData.length > 4) {
        // Minimal SPS parse: read pic_width/height from common profiles
        // Full Exp-Golomb parsing is complex; extract from known byte positions for baseline/main/high
        var profile = spsData[1];
        // For most H.264 streams, dimensions are encoded after profile/level/seq_parameter_set_id
        // Use a bit reader for the Exp-Golomb coded fields
        var br = { data: spsData, pos: 24 }; // skip NAL type(8) + profile(8) + constraints(8) + level(8)
        function readUE(b) { var z = 0; while (b.pos < b.data.length * 8 && !((b.data[b.pos >> 3] >> (7 - (b.pos & 7))) & 1)) { z++; b.pos++; } b.pos++; var v = 0; for (var i = 0; i < z; i++) { v = (v << 1) | ((b.data[b.pos >> 3] >> (7 - (b.pos & 7))) & 1); b.pos++; } return (1 << z) - 1 + v; }
        var seq_parameter_set_id = readUE(br);
        if (profile === 100 || profile === 110 || profile === 122 || profile === 244 || profile === 44 || profile === 83 || profile === 86 || profile === 118 || profile === 128) {
          var chroma = readUE(br);
          if (chroma === 3) br.pos++; // separate_colour_plane_flag
          readUE(br); // bit_depth_luma
          readUE(br); // bit_depth_chroma
          br.pos++; // qpprime_y_zero_transform_bypass
          var scaling = (br.data[br.pos >> 3] >> (7 - (br.pos & 7))) & 1; br.pos++;
          if (scaling) { for (var i = 0; i < (chroma !== 3 ? 8 : 12); i++) { var present = (br.data[br.pos >> 3] >> (7 - (br.pos & 7))) & 1; br.pos++; if (present) { var size = i < 6 ? 16 : 64; for (var j = 0; j < size; j++) readUE(br); } } }
        }
        readUE(br); // log2_max_frame_num
        var poc_type = readUE(br);
        if (poc_type === 0) readUE(br);
        else if (poc_type === 1) { br.pos++; readUE(br); readUE(br); var n = readUE(br); for (var i = 0; i < n; i++) readUE(br); }
        readUE(br); // max_num_ref_frames
        br.pos++; // gaps_in_frame_num
        var pw = readUE(br); // pic_width_in_mbs_minus1
        var ph = readUE(br); // pic_height_in_map_units_minus1
        width = (pw + 1) * 16;
        height = (ph + 1) * 16;
      }
    } catch (e) {
      // SPS parse failed - use defaults
    }

    var timescale = 90000;
    var videoTimescale = timescale;
    var audioTimescale = audio.sampleRate || 44100;

    // Calculate video duration
    var videoDuration = 0;
    if (video.samples.length > 1) {
      videoDuration = video.samples[video.samples.length - 1].dts - video.samples[0].dts;
    }

    // Build ftyp
    var ftyp = box("ftyp", concatArrays(
      new Uint8Array([0x69, 0x73, 0x6F, 0x6D]), // isom
      u32(1), // minor version
      new Uint8Array([0x69, 0x73, 0x6F, 0x6D]), // isom
      new Uint8Array([0x61, 0x76, 0x63, 0x31])  // avc1
    ));

    // Build moov with video and audio tracks
    var mvhd = box("mvhd", concatArrays(
      new Uint8Array(4), // version + flags
      u32(0), u32(0), // creation/modification time
      u32(videoTimescale), // timescale
      u32(videoDuration), // duration
      u16(1), u16(0), // rate 1.0
      new Uint8Array([0x01, 0x00]), // volume 1.0
      new Uint8Array(10), // reserved
      // Matrix (identity)
      u32(0x00010000), u32(0), u32(0),
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000),
      new Uint8Array(24), // pre-defined
      u32(3) // next track ID
    ));

    var videoTrak = buildVideoTrak(video, videoTimescale, videoDuration, width, height);
    var audioTrak = null;
    if (audio.samples.length > 0 && audio.config) {
      var audioDuration = Math.round(audio.samples.length * 1024 * videoTimescale / audioTimescale);
      audioTrak = buildAudioTrak(audio, audioTimescale, audioDuration);
    }

    // mvex for fragmented MP4
    var trex1 = box("trex", concatArrays(new Uint8Array(4), u32(1), u32(1), u32(0), u32(0), u32(0)));
    var trex2 = box("trex", concatArrays(new Uint8Array(4), u32(2), u32(1), u32(0), u32(0), u32(0)));
    var mvex = box("mvex", audioTrak ? concatArrays(trex1, trex2) : trex1);

    var moov = box("moov", audioTrak ? concatArrays(mvhd, videoTrak, audioTrak, mvex) : concatArrays(mvhd, videoTrak, mvex));

    // Build moof + mdat for video
    var videoMoof = buildMoof(1, video, videoTimescale);
    var videoMdat = buildMdat(video.samples);

    var result;
    if (audioTrak && audio.samples.length > 0) {
      var audioMoof = buildMoof(2, audio, audioTimescale);
      var audioMdat = buildMdat(audio.samples);
      result = concatArrays(ftyp, moov, videoMoof, videoMdat, audioMoof, audioMdat);
    } else {
      result = concatArrays(ftyp, moov, videoMoof, videoMdat);
    }

    return result;
  }

  function buildVideoTrak(track, timescale, duration, width, height) {
    var tkhd = box("tkhd", concatArrays(
      new Uint8Array([0x00, 0x00, 0x00, 0x03]), // version + flags (enabled + in movie)
      u32(0), u32(0), // creation/modification
      u32(1), // track ID
      u32(0), // reserved
      u32(duration),
      new Uint8Array(8), // reserved
      u16(0), u16(0), // layer, alternate group
      u16(0), u16(0), // volume, reserved
      // Matrix
      u32(0x00010000), u32(0), u32(0),
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000),
      u16(width), u16(0), // width
      u16(height), u16(0)  // height
    ));

    var mdhd = box("mdhd", concatArrays(
      new Uint8Array(4), u32(0), u32(0),
      u32(timescale), u32(duration),
      u16(0x55C4), u16(0) // language und
    ));

    var hdlr = box("hdlr", concatArrays(
      new Uint8Array(4), u32(0),
      new Uint8Array([0x76, 0x69, 0x64, 0x65]), // "vide"
      new Uint8Array(12),
      new Uint8Array([0x56, 0x69, 0x64, 0x65, 0x6F, 0x00]) // "Video\0"
    ));

    // avcC box
    var avcC = box("avcC", concatArrays(
      new Uint8Array([
        0x01, // version
        track.sps[1], track.sps[2], track.sps[3], // profile, compat, level
        0xFF, // lengthSizeMinusOne = 3 (4 bytes)
        0xE1, // numSPS = 1
      ]),
      u16(track.sps.length), track.sps,
      new Uint8Array([0x01]), // numPPS
      u16(track.pps.length), track.pps
    ));

    var avc1 = box("avc1", concatArrays(
      new Uint8Array(6), // reserved
      u16(1), // data ref index
      new Uint8Array(16), // pre-defined + reserved
      u16(width), u16(height),
      u32(0x00480000), u32(0x00480000), // 72 dpi
      u32(0), // reserved
      u16(1), // frame count
      new Uint8Array(32), // compressor name
      u16(0x0018), // depth
      new Uint8Array([0xFF, 0xFF]), // pre-defined
      avcC
    ));

    var stsd = box("stsd", concatArrays(new Uint8Array(4), u32(1), avc1));
    var stts = box("stts", concatArrays(new Uint8Array(4), u32(0)));
    var stsc = box("stsc", concatArrays(new Uint8Array(4), u32(0)));
    var stsz = box("stsz", concatArrays(new Uint8Array(4), u32(0), u32(0)));
    var stco = box("stco", concatArrays(new Uint8Array(4), u32(0)));

    var stbl = box("stbl", concatArrays(stsd, stts, stsc, stsz, stco));
    var vmhd = box("vmhd", concatArrays(new Uint8Array([0x00, 0x00, 0x00, 0x01]), new Uint8Array(8)));
    var dinf = box("dinf", box("dref", concatArrays(new Uint8Array(4), u32(1), box("url ", new Uint8Array([0x00, 0x00, 0x00, 0x01])))));
    var minf = box("minf", concatArrays(vmhd, dinf, stbl));
    var mdia = box("mdia", concatArrays(mdhd, hdlr, minf));

    return box("trak", concatArrays(tkhd, mdia));
  }

  function buildAudioTrak(track, timescale, duration) {
    var tkhd = box("tkhd", concatArrays(
      new Uint8Array([0x00, 0x00, 0x00, 0x03]),
      u32(0), u32(0), u32(2), u32(0), u32(duration),
      new Uint8Array(8), u16(0), u16(0),
      u16(1), u16(0), // volume 1.0
      u32(0x00010000), u32(0), u32(0),
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000),
      u32(0), u32(0)
    ));

    var mdhd = box("mdhd", concatArrays(
      new Uint8Array(4), u32(0), u32(0),
      u32(timescale),
      u32(Math.round(track.samples.length * 1024)),
      u16(0x55C4), u16(0)
    ));

    var hdlr = box("hdlr", concatArrays(
      new Uint8Array(4), u32(0),
      new Uint8Array([0x73, 0x6F, 0x75, 0x6E]), // "soun"
      new Uint8Array(12),
      new Uint8Array([0x41, 0x75, 0x64, 0x69, 0x6F, 0x00]) // "Audio\0"
    ));

    var esds = box("esds", concatArrays(
      new Uint8Array(4), // version
      new Uint8Array([
        0x03, // ES_DescrTag
        0x19, // length
        0x00, 0x02, // ES_ID
        0x00, // stream priority
        0x04, // DecoderConfigDescrTag
        0x11, // length
        0x40, // objectTypeIndication (AAC)
        0x15, // streamType (audio)
        0x00, 0x00, 0x00, // bufferSizeDB
        0x00, 0x01, 0xF4, 0x00, // maxBitrate
        0x00, 0x01, 0xF4, 0x00, // avgBitrate
        0x05, // DecoderSpecificInfoTag
        0x02, // length
      ]),
      track.config,
      new Uint8Array([0x06, 0x01, 0x02]) // SLConfigDescrTag
    ));

    var mp4a = box("mp4a", concatArrays(
      new Uint8Array(6), u16(1), // data ref
      new Uint8Array(8),
      u16(track.channels), u16(16), // channels, sample size
      u16(0), u16(0), // compression, packet size
      u16(track.sampleRate), u16(0), // sample rate
      esds
    ));

    var stsd = box("stsd", concatArrays(new Uint8Array(4), u32(1), mp4a));
    var stts = box("stts", concatArrays(new Uint8Array(4), u32(0)));
    var stsc = box("stsc", concatArrays(new Uint8Array(4), u32(0)));
    var stsz = box("stsz", concatArrays(new Uint8Array(4), u32(0), u32(0)));
    var stco = box("stco", concatArrays(new Uint8Array(4), u32(0)));

    var stbl = box("stbl", concatArrays(stsd, stts, stsc, stsz, stco));
    var smhd = box("smhd", new Uint8Array(8));
    var dinf = box("dinf", box("dref", concatArrays(new Uint8Array(4), u32(1), box("url ", new Uint8Array([0x00, 0x00, 0x00, 0x01])))));
    var minf = box("minf", concatArrays(smhd, dinf, stbl));
    var mdia = box("mdia", concatArrays(mdhd, hdlr, minf));

    return box("trak", concatArrays(tkhd, mdia));
  }

  function buildMoof(trackId, track, timescale) {
    var mfhd = box("mfhd", concatArrays(new Uint8Array(4), u32(1)));

    var flags = 0x000301; // data-offset + sample-duration + sample-size
    if (trackId === 1) flags |= 0x000400; // sample-flags-present for video

    var baseDts = track.samples.length > 0 ? track.samples[0].dts : 0;

    var tfhdData = concatArrays(new Uint8Array([0x00, 0x02, 0x00, 0x00]), u32(trackId));
    var tfhd = box("tfhd", tfhdData);

    var tfdt = box("tfdt", concatArrays(new Uint8Array([0x01, 0x00, 0x00, 0x00]), u32(0), u32(baseDts)));

    // Build trun
    var sampleCount = track.samples.length;
    var trunFlags = new Uint8Array([0x00, 0x00, 0x0F, 0x01]); // data-offset + duration + size + flags + cts
    var trunData = [trunFlags, u32(sampleCount), u32(0)]; // data offset placeholder

    for (var i = 0; i < sampleCount; i++) {
      var sample = track.samples[i];
      var nextDts = (i + 1 < sampleCount) ? track.samples[i + 1].dts : sample.dts + (timescale / 30);
      var duration = Math.max(1, Math.round(nextDts - sample.dts));
      var sampleFlags = sample.isKeyframe ? 0x02000000 : 0x01010000;
      var cts = Math.max(0, sample.pts - sample.dts);

      trunData.push(u32(duration));
      trunData.push(u32(sample.size));
      trunData.push(u32(sampleFlags));
      trunData.push(u32(cts));
    }

    var trun = box("trun", concatArrays.apply(null, trunData));
    var traf = box("traf", concatArrays(tfhd, tfdt, trun));

    // Calculate data offset (moof size + 8 for mdat header)
    var moof = box("moof", concatArrays(mfhd, traf));
    var dataOffset = moof.length + 8;
    // Patch data offset in trun
    var trunOffset = findTrunDataOffset(moof);
    if (trunOffset >= 0) {
      moof[trunOffset] = (dataOffset >> 24) & 0xFF;
      moof[trunOffset + 1] = (dataOffset >> 16) & 0xFF;
      moof[trunOffset + 2] = (dataOffset >> 8) & 0xFF;
      moof[trunOffset + 3] = dataOffset & 0xFF;
    }

    return moof;
  }

  function findTrunDataOffset(moof) {
    // Find trun box and locate the data offset field
    // trun: 4 bytes version/flags + 4 bytes sample count + 4 bytes data offset
    for (var i = 0; i < moof.length - 4; i++) {
      if (moof[i] === 0x74 && moof[i + 1] === 0x72 && moof[i + 2] === 0x75 && moof[i + 3] === 0x6E) {
        // Found "trun", data offset is at +8 (after version/flags + sample count)
        return i + 4 + 4 + 4; // type + version/flags + sampleCount -> dataOffset
      }
    }
    return -1;
  }

  function buildMdat(samples) {
    var totalSize = 0;
    for (var i = 0; i < samples.length; i++) totalSize += samples[i].data.length;
    var data = new Uint8Array(totalSize);
    var offset = 0;
    for (var i = 0; i < samples.length; i++) {
      data.set(samples[i].data, offset);
      offset += samples[i].data.length;
    }
    return box("mdat", data);
  }

  // --- Public API ---
  return {
    remux: function (tsData) {
      var tracks = demuxTS(tsData);
      var mp4 = muxToMP4(tracks);
      return mp4;
    }
  };
})();
