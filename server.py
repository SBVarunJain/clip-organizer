"""Local clip organizer + trimmer for NVIDIA ShadowPlay captures.

Run with: .venv\\Scripts\\python.exe -m uvicorn server:app --host 127.0.0.1 --port 8765
Or just double-click run.bat.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

APP_DIR = Path(__file__).resolve().parent
THUMBS_DIR = APP_DIR / "thumbnails"
META_CACHE = APP_DIR / "meta_cache.json"
CONFIG_FILE = APP_DIR / "config.json"

THUMBS_DIR.mkdir(exist_ok=True)

VIDEO_EXTS = {".mp4", ".mkv", ".mov"}
SKIP_NAMES = {".git", "node_modules", "__pycache__"}
NVIDIA_DATE = re.compile(r"(\d{4})\.(\d{2})\.(\d{2})\s*-\s*(\d{2})\.(\d{2})\.(\d{2})")


# --------------------------------------------------------------------------
# Config (paths to clips + output)
# --------------------------------------------------------------------------
class Config:
    """Holds the user's chosen clips_dir and output_dir.

    Persisted in config.json. If config is missing/invalid the app shows
    the setup screen and refuses path-dependent endpoints until set.
    """

    def __init__(self) -> None:
        self.clips_dir: Optional[Path] = None
        self.output_dir: Optional[Path] = None
        self._lock = threading.Lock()
        self.load()

    def load(self) -> None:
        if not CONFIG_FILE.exists():
            return
        try:
            data = json.loads(CONFIG_FILE.read_text())
            c = Path(data.get("clips_dir", "")).expanduser()
            o = Path(data.get("output_dir", "")).expanduser()
            if c.is_dir():
                self.clips_dir = c.resolve()
            if o.is_dir() or not o.exists():
                # Output may not exist yet — we'll create it on first use
                self.output_dir = o.resolve() if o.exists() else o
        except Exception:
            pass

    def save(self, clips_dir: str, output_dir: str) -> None:
        c = Path(clips_dir).expanduser()
        if not c.is_dir():
            raise ValueError(f"Captures folder does not exist: {c}")
        o = Path(output_dir).expanduser()
        o.mkdir(parents=True, exist_ok=True)
        if c.resolve() == o.resolve():
            raise ValueError("Captures folder and output folder must be different")
        with self._lock:
            CONFIG_FILE.write_text(json.dumps({
                "clips_dir": str(c.resolve()),
                "output_dir": str(o.resolve()),
            }, indent=2))
            self.clips_dir = c.resolve()
            self.output_dir = o.resolve()

    @property
    def configured(self) -> bool:
        return self.clips_dir is not None and self.output_dir is not None

    def require(self) -> tuple[Path, Path]:
        if not self.configured:
            raise HTTPException(412, "setup_required")
        return self.clips_dir, self.output_dir  # type: ignore[return-value]


CONFIG = Config()


def suggest_paths() -> dict:
    """Suggest sensible defaults for first-run setup."""
    home = Path.home()
    candidates_clips = [
        home / "Videos" / "NVIDIA",
        home / "Videos" / "Captures",
        home / "Videos",
    ]
    clips = next((str(p) for p in candidates_clips if p.is_dir()), str(home / "Videos"))
    # Output: alongside clips by default
    output = str(Path(clips) / "Trimmed Clips")
    return {"clips_dir": clips, "output_dir": output}


# --------------------------------------------------------------------------
# Metadata cache: path -> {"mtime": float, "duration": float}
# --------------------------------------------------------------------------
_meta_lock = threading.Lock()


def _load_cache() -> dict:
    if META_CACHE.exists():
        try:
            return json.loads(META_CACHE.read_text())
        except Exception:
            return {}
    return {}


def _save_cache(cache: dict) -> None:
    tmp = META_CACHE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache))
    tmp.replace(META_CACHE)


_cache = _load_cache()


def probe_duration(path: Path) -> float:
    key = str(path)
    with _meta_lock:
        entry = _cache.get(key)
        st = path.stat()
        if entry and entry.get("mtime") == st.st_mtime:
            return float(entry["duration"])
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True, text=True, check=True, timeout=30,
        )
        dur = float(out.stdout.strip())
    except Exception:
        dur = 0.0
    with _meta_lock:
        _cache[key] = {"mtime": st.st_mtime, "duration": dur}
        _save_cache(_cache)
    return dur


def parse_nvidia_date(name: str) -> Optional[str]:
    m = NVIDIA_DATE.search(name)
    if not m:
        return None
    y, mo, d, h, mi, s = m.groups()
    try:
        return datetime(int(y), int(mo), int(d), int(h), int(mi), int(s)).isoformat()
    except ValueError:
        return None


# --------------------------------------------------------------------------
# FastAPI
# --------------------------------------------------------------------------
app = FastAPI(title="Clip Organizer")


@app.middleware("http")
async def no_cache(request: Request, call_next):
    response = await call_next(request)
    # Local app — never let the browser hold onto stale static assets.
    response.headers["Cache-Control"] = "no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


# --------------------------------------------------------------------------
# Config endpoints
# --------------------------------------------------------------------------
class ConfigPost(BaseModel):
    clips_dir: str
    output_dir: str


@app.get("/api/config")
def get_config():
    return {
        "configured": CONFIG.configured,
        "clips_dir": str(CONFIG.clips_dir) if CONFIG.clips_dir else None,
        "output_dir": str(CONFIG.output_dir) if CONFIG.output_dir else None,
        "suggestions": suggest_paths(),
    }


@app.post("/api/config")
def set_config(req: ConfigPost):
    try:
        CONFIG.save(req.clips_dir, req.output_dir)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except OSError as e:
        raise HTTPException(400, f"Could not create output folder: {e}")
    return {"configured": True, "clips_dir": str(CONFIG.clips_dir), "output_dir": str(CONFIG.output_dir)}


# --------------------------------------------------------------------------
# Safe path helpers
# --------------------------------------------------------------------------
def _safe_game(game: str) -> Path:
    """Resolve a game folder name to its path, rejecting traversal."""
    clips_root, _ = CONFIG.require()
    if "/" in game or "\\" in game or game.startswith((".", "_")) or game in SKIP_NAMES:
        raise HTTPException(400, "Invalid game name")
    p = (clips_root / game).resolve()
    try:
        p.relative_to(clips_root)
    except ValueError:
        raise HTTPException(400, "Invalid path")
    if not p.is_dir():
        raise HTTPException(404, "Game folder not found")
    return p


def _safe_file(game_dir: Path, filename: str) -> Path:
    if "/" in filename or "\\" in filename or filename.startswith(".."):
        raise HTTPException(400, "Invalid filename")
    p = (game_dir / filename).resolve()
    try:
        p.relative_to(game_dir)
    except ValueError:
        raise HTTPException(400, "Invalid path")
    if not p.is_file():
        raise HTTPException(404, "Clip not found")
    return p


def _output_path(game: str) -> Path:
    _, out_root = CONFIG.require()
    if "/" in game or "\\" in game or game.startswith((".", "_")):
        raise HTTPException(400, "Invalid game name")
    return out_root / game


_RANGE_RE = re.compile(r"^bytes=(\d+)-(\d*)$")


def _serve_video_range(request: Request, path: Path) -> StreamingResponse | FileResponse:
    """Serve a video file with HTTP Range support so the browser can seek.

    Starlette's FileResponse didn't honor Range until 0.41; we implement it
    here so we don't depend on a specific version.
    """
    file_size = path.stat().st_size
    range_header = request.headers.get("range", "")
    base_headers = {"Accept-Ranges": "bytes"}

    if not range_header:
        return FileResponse(str(path), media_type="video/mp4", headers=base_headers)

    m = _RANGE_RE.match(range_header.strip())
    if not m:
        raise HTTPException(416, "Invalid Range header")
    start = int(m.group(1))
    end = int(m.group(2)) if m.group(2) else file_size - 1
    if end >= file_size:
        end = file_size - 1
    if start > end or start >= file_size:
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{file_size}"},
        )
    chunk = end - start + 1

    def stream():
        with open(path, "rb") as f:
            f.seek(start)
            remaining = chunk
            # 256 KiB chunks balance memory and syscall overhead.
            while remaining > 0:
                buf = f.read(min(256 * 1024, remaining))
                if not buf:
                    break
                remaining -= len(buf)
                yield buf

    headers = {
        **base_headers,
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Content-Length": str(chunk),
    }
    return StreamingResponse(stream(), status_code=206, headers=headers, media_type="video/mp4")


# --------------------------------------------------------------------------
# Captures (source clips)
# --------------------------------------------------------------------------
@app.get("/api/games")
def list_games():
    clips_root, output_root = CONFIG.require()
    # Skip the output folder if it's inside clips_root
    skip_resolved: set[str] = set(SKIP_NAMES)
    try:
        out_rel = output_root.resolve().relative_to(clips_root.resolve())
        skip_resolved.add(str(out_rel).split(os.sep)[0])
    except (ValueError, OSError):
        pass

    out = []
    for entry in sorted(clips_root.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_dir():
            continue
        if entry.name in skip_resolved or entry.name.startswith((".", "_")):
            continue
        clips = [f for f in entry.iterdir() if f.is_file() and f.suffix.lower() in VIDEO_EXTS]
        if not clips:
            continue
        latest = max((c.stat().st_mtime for c in clips), default=0)
        out.append({"name": entry.name, "count": len(clips), "latest_mtime": latest})
    out.sort(key=lambda g: g["latest_mtime"], reverse=True)
    return out


@app.get("/api/clips")
def list_clips(game: str = Query(...)):
    game_dir = _safe_game(game)
    clips = []
    for f in game_dir.iterdir():
        if not f.is_file() or f.suffix.lower() not in VIDEO_EXTS:
            continue
        st = f.stat()
        clips.append({
            "filename": f.name,
            "size": st.st_size,
            "mtime": st.st_mtime,
            "parsed_date": parse_nvidia_date(f.name),
        })
    clips.sort(key=lambda c: c["mtime"], reverse=True)
    return clips


@app.get("/api/clip-meta")
def clip_meta(game: str = Query(...), file: str = Query(...)):
    game_dir = _safe_game(game)
    path = _safe_file(game_dir, file)
    return {"filename": path.name, "size": path.stat().st_size, "duration": probe_duration(path)}


@app.get("/api/video")
def serve_video(request: Request, game: str = Query(...), file: str = Query(...)):
    game_dir = _safe_game(game)
    path = _safe_file(game_dir, file)
    return _serve_video_range(request, path)


def _make_thumb(src: Path, thumb: Path) -> None:
    src_mtime = src.stat().st_mtime
    if thumb.exists() and thumb.stat().st_mtime >= src_mtime:
        return
    thumb.parent.mkdir(parents=True, exist_ok=True)
    dur = probe_duration(src)
    ts = max(0.5, dur * 0.05) if dur > 1 else 0.0
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-ss", str(ts), "-i", str(src),
                "-frames:v", "1", "-vf", "scale=320:-2",
                "-q:v", "5", str(thumb),
            ],
            capture_output=True, check=True, timeout=30,
        )
    except subprocess.CalledProcessError as e:
        raise HTTPException(500, f"Thumbnail failed: {e.stderr.decode(errors='ignore')[:200]}")


@app.get("/api/thumb")
def serve_thumb(game: str = Query(...), file: str = Query(...)):
    game_dir = _safe_game(game)
    path = _safe_file(game_dir, file)
    thumb = THUMBS_DIR / "captures" / game / (path.stem + ".jpg")
    _make_thumb(path, thumb)
    return FileResponse(str(thumb), media_type="image/jpeg")


@app.get("/api/thumb-output")
def serve_thumb_output(game: str = Query(...), file: str = Query(...)):
    out_dir = _output_path(game)
    if "/" in file or "\\" in file or file.startswith(".."):
        raise HTTPException(400, "Invalid filename")
    src = (out_dir / file).resolve()
    try:
        src.relative_to(out_dir.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid path")
    if not src.is_file():
        raise HTTPException(404, "Output not found")
    thumb = THUMBS_DIR / "outputs" / game / (src.stem + ".jpg")
    _make_thumb(src, thumb)
    return FileResponse(str(thumb), media_type="image/jpeg")


# --------------------------------------------------------------------------
# Outputs (trimmed clips)
# --------------------------------------------------------------------------
@app.get("/api/outputs")
def list_outputs(game: str = Query(...)):
    out_dir = _output_path(game)
    if not out_dir.is_dir():
        return []
    items = []
    for f in out_dir.iterdir():
        if f.is_file() and f.suffix.lower() in VIDEO_EXTS:
            st = f.stat()
            items.append({"filename": f.name, "size": st.st_size, "mtime": st.st_mtime})
    items.sort(key=lambda c: c["mtime"], reverse=True)
    return items


@app.get("/api/output-file")
def serve_output(request: Request, game: str = Query(...), file: str = Query(...)):
    out_dir = _output_path(game)
    if "/" in file or "\\" in file:
        raise HTTPException(400, "Invalid filename")
    p = (out_dir / file).resolve()
    try:
        p.relative_to(out_dir.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid path")
    if not p.is_file():
        raise HTTPException(404)
    return _serve_video_range(request, p)


@app.post("/api/reveal")
def reveal(game: str = Query(...)):
    """Open Explorer at the output folder for this game."""
    target = _output_path(game)
    target.mkdir(parents=True, exist_ok=True)
    try:
        if os.name == "nt":
            subprocess.Popen(["explorer.exe", str(target)])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target)])
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"opened": str(target)}


# --------------------------------------------------------------------------
# Trim jobs
# --------------------------------------------------------------------------
jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


class TrimRequest(BaseModel):
    game: str
    file: str
    start: float
    end: float
    target_mb: float = 9.0  # ~10MB Discord limit with safety margin
    audio_kbps: int = 128


def _set_job(job_id: str, **fields) -> None:
    with _jobs_lock:
        jobs[job_id].update(fields)


def _run_ffmpeg_with_progress(cmd: list[str], job_id: str, duration: float, phase_base: float, phase_span: float) -> None:
    """Run ffmpeg, parsing -progress output and updating job progress."""
    full_cmd = cmd + ["-progress", "pipe:1", "-nostats"]
    stderr_buf = tempfile.TemporaryFile()
    try:
        proc = subprocess.Popen(
            full_cmd,
            stdout=subprocess.PIPE, stderr=stderr_buf,
            text=True, encoding="utf-8", errors="replace",
            bufsize=1,
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if line.startswith("out_time_us="):
                val = line.split("=", 1)[1].strip()
                if val and val != "N/A":
                    try:
                        secs = int(val) / 1_000_000
                        frac = max(0.0, min(1.0, secs / duration)) if duration > 0 else 0
                        _set_job(job_id, progress=phase_base + frac * phase_span)
                    except ValueError:
                        pass
        proc.wait()
        if proc.returncode != 0:
            stderr_buf.seek(0)
            err = stderr_buf.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ffmpeg exited {proc.returncode}: {err[-800:]}")
    finally:
        stderr_buf.close()


def _choose_scale(video_kbps: float) -> Optional[str]:
    if video_kbps >= 4500:
        return None
    if video_kbps >= 2200:
        return "scale=-2:720"
    if video_kbps >= 900:
        return "scale=-2:540"
    if video_kbps >= 400:
        return "scale=-2:360"
    return "scale=-2:240"


def _trim_worker(job_id: str, src: Path, out: Path, start: float, end: float, target_mb: float, audio_kbps: int) -> None:
    try:
        _set_job(job_id, status="running", progress=0.0)
        duration = max(0.1, end - start)
        safety = 0.95
        total_kbps = (target_mb * 1024 * 1024 * 8 * safety) / duration / 1000.0
        video_kbps = max(150, total_kbps - audio_kbps)
        scale = _choose_scale(video_kbps)

        out.parent.mkdir(parents=True, exist_ok=True)
        passlog = str(out.with_suffix("")) + ".passlog"

        base = [
            "ffmpeg", "-y",
            "-ss", f"{start:.3f}",
            "-i", str(src),
            "-t", f"{duration:.3f}",
            "-c:v", "libx264",
            "-preset", "medium",
            "-b:v", f"{int(video_kbps)}k",
            "-pix_fmt", "yuv420p",
        ]
        if scale:
            base += ["-vf", scale]

        pass1 = base + ["-pass", "1", "-passlogfile", passlog, "-an", "-f", "null", "-"]
        pass2 = base + [
            "-pass", "2", "-passlogfile", passlog,
            "-c:a", "aac", "-b:a", f"{audio_kbps}k",
            "-movflags", "+faststart",
            str(out),
        ]

        _set_job(job_id, phase="pass1", video_kbps=int(video_kbps), scale=scale or "source")
        _run_ffmpeg_with_progress(pass1, job_id, duration, 0.0, 0.5)
        _set_job(job_id, phase="pass2")
        _run_ffmpeg_with_progress(pass2, job_id, duration, 0.5, 0.5)

        for suffix in ("-0.log", "-0.log.mbtree"):
            try:
                Path(passlog + suffix).unlink()
            except FileNotFoundError:
                pass

        size = out.stat().st_size
        _set_job(job_id, status="done", progress=1.0, output=out.name, output_size=size, output_path=str(out))
    except Exception as e:
        _set_job(job_id, status="failed", error=str(e))


@app.post("/api/trim")
def start_trim(req: TrimRequest):
    game_dir = _safe_game(req.game)
    src = _safe_file(game_dir, req.file)
    if req.end <= req.start:
        raise HTTPException(400, "end must be greater than start")
    if req.target_mb < 1 or req.target_mb > 500:
        raise HTTPException(400, "target_mb out of range")

    out_dir = _output_path(req.game)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(req.file).stem
    safe_stem = re.sub(r"[^\w\- ]+", "_", stem)
    s_lbl = f"{int(req.start)}s-{int(req.end)}s"
    out_path = out_dir / f"{safe_stem}_{s_lbl}.mp4"
    n = 1
    while out_path.exists():
        out_path = out_dir / f"{safe_stem}_{s_lbl}_{n}.mp4"
        n += 1

    job_id = uuid.uuid4().hex[:12]
    with _jobs_lock:
        jobs[job_id] = {
            "status": "queued",
            "progress": 0.0,
            "game": req.game,
            "src": req.file,
            "out_name": out_path.name,
            "created": time.time(),
        }
    threading.Thread(
        target=_trim_worker,
        args=(job_id, src, out_path, req.start, req.end, req.target_mb, req.audio_kbps),
        daemon=True,
    ).start()
    return {"job_id": job_id}


@app.get("/api/job/{job_id}")
def job_status(job_id: str):
    with _jobs_lock:
        j = jobs.get(job_id)
        if not j:
            raise HTTPException(404, "Job not found")
        return dict(j)


# --------------------------------------------------------------------------
# Static files
# --------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=str(APP_DIR / "static"), html=True), name="static")
