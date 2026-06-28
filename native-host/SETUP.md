# Toxic Downloader — System FFmpeg Setup (Windows, one-click)

This enables large-file remuxing **and subtitle embedding** by registering the
native FFmpeg host with Chrome. No console typing required.

## 1. Install the prerequisites (one time)

The native host needs both of these on your **PATH**:

- **Python 3** — https://python.org (during install, tick **"Add Python to PATH"**)
- **FFmpeg** — https://ffmpeg.org/download.html (add its `bin` folder to PATH,
  or drop `ffmpeg.exe` at `C:\ffmpeg\bin\ffmpeg.exe`, which the host also checks)

**Check they're installed:** open Command Prompt (Win+R → `cmd`) and run:

```
python --version
ffmpeg -version
```

Each should print a version. If you get "not recognized", it's not on PATH yet —
reinstall with the PATH option ticked (or add it manually), then re-open cmd.

## 2. Register the host (pick ONE — double-click it)

- **`register_host.bat`**  ← recommended. Rewrites the manifest with the correct
  paths and registers it in the registry, no prompts. (Click **Yes** if Windows
  SmartScreen warns about an unrecognized app → More info → Run anyway.)
- **`register_host.reg`**  ← alternative. Just sets the registry key to point at
  the manifest. Double-click → **Yes** to merge. (Use this only if the manifest's
  baked-in extension ID already matches yours — see step 4.)

After running either, **fully restart Chrome** (close all windows).

## 3. Turn it on in the extension

Open Toxic Downloader **Settings → Remux Engine → "System FFmpeg"** and save.
Stream downloads will now be saved as `.ts`, remuxed to `.mp4`, and have
subtitles embedded automatically.

## 4. If your extension ID is different

The host is locked to one extension ID. The ID baked in here is:

```
gmjhfmlmjjoffnamfcgggnhmfbmgpblh
```

**Find your actual ID:** go to `chrome://extensions`, enable **Developer mode**
(top-right), and read the **ID** shown under *Toxic Downloader*.

If it does **not** match the ID above, re-run the `.bat` with your ID as an
argument (this rewrites the manifest's `allowed_origins` and re-registers):

1. Open Command Prompt in this `native-host` folder (Shift+right-click the folder
   → "Open in Terminal" / "Open command window here").
2. Run:

   ```
   register_host.bat YOUR_EXTENSION_ID
   ```

   (paste your real ID in place of `YOUR_EXTENSION_ID`)

Then restart Chrome. The `.reg` file does **not** update the ID — use the `.bat`
for that.

## Troubleshooting

- **Still saves only a `.ts` file:** the host isn't being reached. Re-check that
  Chrome was fully restarted, the extension ID matches (step 4), and Python +
  FFmpeg pass the checks in step 1.
- **"FFmpeg not found":** FFmpeg isn't on PATH — see step 1.
- **Diagnostics:** the extension logs each remux attempt under
  **History → Activity Log** (look for `[native]` lines).
