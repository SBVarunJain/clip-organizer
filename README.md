# Clip Organizer

A local web app for organizing your game clips and trimming them down to a size you can share on Discord.

It scans a folder of clips (organized into per-game subfolders, the way NVIDIA ShadowPlay saves them by default), shows them in a tidy grid with thumbnails, and lets you scrub a trim range over the video. Trimmed clips are re-encoded with two-pass H.264 to land just under your chosen Discord file-size limit, and saved to a matching subfolder in your output directory.

![](docs/screenshot.png)

## Features

- **Browse by game** — auto-detects each game folder under your captures directory
- **Thumbnails, search, sort** — visual grid, with search-as-you-type and sort by date / size / name
- **In-browser trim** — HTML5 video player + dual-handle timeline. Drag handles or click anywhere to scrub.
- **Discord-friendly sizing** — picks a target of 10 MB (free), 25 MB (boosted), 50 MB (Nitro Basic), or 500 MB (Nitro) and auto-selects resolution + bitrate to hit it
- **Two-pass encoding** — accurate size targeting with live progress bar
- **Organized outputs** — trimmed clips are saved to `<output-folder>/<Game>/`, never mixed with raw captures
- **Configurable folders** — pick any captures and output paths via the in-app setup; no hard-coded paths

## Requirements

- **Windows** (also runs on macOS / Linux if you swap `run.bat` for `uvicorn server:app`)
- **Python 3.10+** — [python.org/downloads](https://www.python.org/downloads/)
- **ffmpeg** on your PATH — `winget install Gyan.FFmpeg`, or download from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)

That's it. All other dependencies install into a local virtualenv on first run.

## Quick start

1. Clone or download this repo.
2. Double-click `run.bat`. On first run it creates a `.venv` and installs FastAPI + uvicorn (~10 seconds).
3. Your browser opens to `http://127.0.0.1:8765`. You'll see a setup screen — point it at:
   - **Captures folder** — where your game-organized clips live (e.g. `C:\Users\You\Videos\NVIDIA`)
   - **Output folder** — where trimmed clips should go (e.g. `C:\Users\You\Videos\NVIDIA\Trimmed Clips`)
4. Click a clip, drag the trim handles, hit **Trim & Save**.

To change folders later, click **Settings** in the sidebar.

## How the sizing works

The encoder calculates:

```
total_bitrate = target_size * 0.95 / duration         (95% safety margin)
video_bitrate = total_bitrate - audio_bitrate
```

…then picks a resolution that suits the available video bitrate:

| Video bitrate | Resolution |
| ------------- | ---------- |
| ≥ 4.5 Mbps    | source     |
| ≥ 2.2 Mbps    | 720p       |
| ≥ 0.9 Mbps    | 540p       |
| ≥ 0.4 Mbps    | 360p       |
| < 0.4 Mbps    | 240p       |

A second pass nails the final bitrate so the output reliably lands under your target.

## Folder layout

```
clip-organizer/
├── server.py            # FastAPI backend (config, clip scanning, ffmpeg jobs)
├── static/              # Frontend (HTML + CSS + vanilla JS, no build step)
├── requirements.txt
├── run.bat              # Double-click launcher (creates .venv on first run)
├── config.json          # Created on first setup (gitignored)
├── thumbnails/          # Generated thumbnail cache (gitignored)
└── meta_cache.json      # ffprobe duration cache (gitignored)
```

## Notes

- **Discord 10 MB limit:** trimmed clips target ~9.5 MB to leave room for container overhead. They land near 8.5–9.7 MB in practice.
- **Thumbnails cache** to `thumbnails/`, keyed by source file mtime. Re-saving a clip in NVIDIA's overlay invalidates its thumbnail.
- **Trim time** is roughly 2× the clip duration (two-pass H.264 at medium preset on a modern CPU).
- **First scan** of a big folder may take a few seconds while thumbnails generate; subsequent loads are instant.

## License

MIT — see [LICENSE](LICENSE).
