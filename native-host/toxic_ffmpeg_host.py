#!/usr/bin/env python3
"""
Toxic Downloader - Native FFmpeg Host
Receives TS file paths from the extension, remuxes to MP4 with optional subtitles.
"""

import sys
import json
import struct
import subprocess
import os
import re
import base64
import tempfile

def read_message():
    """Read a native messaging message from stdin."""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    length = struct.unpack("=I", raw_length)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))

def send_message(msg):
    """Send a native messaging message to stdout."""
    encoded = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

def find_ffmpeg(custom_path=None):
    """Find ffmpeg binary."""
    if custom_path and custom_path != "ffmpeg":
        if os.path.isfile(custom_path):
            return custom_path

    # Check common locations
    candidates = ["ffmpeg"]
    if sys.platform == "win32":
        candidates.extend([
            r"C:\ffmpeg\bin\ffmpeg.exe",
            r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
            os.path.expanduser(r"~\ffmpeg\bin\ffmpeg.exe"),
        ])
    else:
        candidates.extend(["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"])

    for path in candidates:
        try:
            result = subprocess.run([path, "-version"], capture_output=True, timeout=5)
            if result.returncode == 0:
                return path
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue

    return None

def remux(input_path, output_path, audio_path=None, subtitle_path=None, subtitle_lang="eng", ffmpeg_path="ffmpeg"):
    """Remux to MP4 using ffmpeg. Supports separate audio track and subtitle embedding."""
    cmd = [ffmpeg_path, "-y"]
    # Extended probing for large/complex containers
    cmd.extend(["-probesize", "100M", "-analyzeduration", "100M"])
    cmd.extend(["-i", input_path])

    next_input = 1  # track input index for mapping

    if audio_path and os.path.isfile(audio_path):
        cmd.extend(["-i", audio_path])
        audio_input = next_input
        next_input += 1
    else:
        audio_input = None

    if subtitle_path and os.path.isfile(subtitle_path):
        cmd.extend(["-i", subtitle_path])
        sub_input = next_input
        next_input += 1
    else:
        sub_input = None

    # Map streams explicitly
    cmd.extend(["-map", "0:v"])
    if audio_input is not None:
        # Separate audio file (DASH) — take audio from second input
        cmd.extend(["-map", f"{audio_input}:a"])
    else:
        # Audio is muxed with video — map all audio streams
        cmd.extend(["-map", "0:a?"])

    if sub_input is not None:
        cmd.extend(["-map", f"{sub_input}:0"])

    cmd.extend(["-c:v", "copy", "-c:a", "copy"])

    if sub_input is not None:
        cmd.extend(["-c:s", "mov_text"])
        cmd.extend(["-metadata:s:s:0", f"language={subtitle_lang}"])

    cmd.extend(["-movflags", "+faststart", output_path])

    result = subprocess.run(cmd, capture_output=True, timeout=600)
    return result.returncode == 0, result.stderr.decode("utf-8", errors="replace")[-500:]

def main():
    open_files = {}  # path -> file handle

    while True:
        msg = read_message()
        if msg is None:
            break

        action = msg.get("action")

        if action == "writeStart":
            path = msg.get("path", "")
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                open_files[path] = open(path, "wb")
                send_message({"success": True})
            except Exception as e:
                send_message({"success": False, "error": str(e)})

        elif action == "writeChunk":
            path = msg.get("path", "")
            f = open_files.get(path)
            if not f:
                send_message({"success": False, "error": "File not open: " + path})
                continue
            try:
                data = base64.b64decode(msg.get("data", ""))
                f.write(data)
                send_message({"success": True, "wrote": len(data)})
            except Exception as e:
                send_message({"success": False, "error": str(e)})

        elif action == "writeEnd":
            path = msg.get("path", "")
            f = open_files.pop(path, None)
            if f:
                f.close()
            size = os.path.getsize(path) if os.path.isfile(path) else 0
            send_message({"success": True, "path": path, "size": size})

        elif action == "ping":
            ffmpeg = find_ffmpeg(msg.get("ffmpegPath"))
            send_message({"success": True, "ffmpegFound": ffmpeg is not None, "path": ffmpeg or ""})

        elif action == "remux":
            input_path = msg.get("inputPath", "")
            audio_path = msg.get("audioPath", "")
            subtitle_text = msg.get("subtitleText", "")
            subtitle_lang = msg.get("subtitleLang", "eng")
            if not re.match(r'^[a-zA-Z]{2,3}$', subtitle_lang):
                subtitle_lang = "eng"
            ffmpeg_path = msg.get("ffmpegPath", "ffmpeg")

            ffmpeg = find_ffmpeg(ffmpeg_path)
            if not ffmpeg:
                send_message({"success": False, "error": "FFmpeg not found. Install FFmpeg and add to PATH."})
                continue

            if not os.path.isfile(input_path):
                send_message({"success": False, "error": f"Input file not found: {input_path}"})
                continue

            # Create output path (same name but .mp4)
            base = os.path.splitext(input_path)[0]
            output_path = base + ".mp4"

            # Handle case where input is already .mp4
            if input_path.endswith(".mp4"):
                output_path = base + "_remuxed.mp4"

            # Write subtitle to temp file if provided
            sub_path = None
            if subtitle_text:
                sub_path = base + ".temp_sub.srt"
                with open(sub_path, "w", encoding="utf-8") as f:
                    f.write(subtitle_text)

            # Validate audio path
            audio_file = audio_path if audio_path and os.path.isfile(audio_path) else None

            try:
                success, stderr = remux(input_path, output_path, audio_file, sub_path, subtitle_lang, ffmpeg)

                # Cleanup temp files
                if sub_path and os.path.isfile(sub_path):
                    os.remove(sub_path)

                if success and os.path.isfile(output_path):
                    size = os.path.getsize(output_path)

                    # Remove original input files
                    if input_path != output_path:
                        try:
                            os.remove(input_path)
                        except:
                            pass
                    if audio_file:
                        try:
                            os.remove(audio_file)
                        except:
                            pass

                    # Rename if we used _remuxed suffix
                    if output_path.endswith("_remuxed.mp4"):
                        final_path = base + ".mp4"
                        try:
                            if os.path.isfile(final_path):
                                os.remove(final_path)
                            os.rename(output_path, final_path)
                            output_path = final_path
                        except:
                            pass

                    send_message({"success": True, "outputPath": output_path, "size": size})
                else:
                    send_message({"success": False, "error": "FFmpeg failed: " + stderr[-200:]})
            except subprocess.TimeoutExpired:
                send_message({"success": False, "error": "FFmpeg timed out (10 min limit)"})
            except Exception as e:
                send_message({"success": False, "error": str(e)})

        else:
            send_message({"success": False, "error": "Unknown action: " + str(action)})

if __name__ == "__main__":
    main()
