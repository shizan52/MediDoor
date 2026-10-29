"""
MediDoor — One-shot launcher.

Usage:  python run.py

What it does (idempotent — safe to re-run):
  1. Creates `backend/.venv` if missing and pip-installs requirements.
  2. Creates `backend/.env` from `.env.example` and generates a SECRET_KEY.
  3. Runs `npm install` in each Next app when `node_modules` is missing:
      - frontend/          -> website          http://localhost:3000
      - mobile-customer/   -> customer mobile  http://localhost:3100
      - mobile-pharmacy/   -> pharmacy mobile  http://localhost:3200
      - mobile-rider/      -> rider mobile     http://localhost:3300
  4. Creates `.env.local` for each Next app from an example if missing.
  5. Spawns ALL servers in parallel with prefixed log streams:
      - FastAPI backend    -> http://localhost:8000   (Swagger: /docs)
      - Website            -> http://localhost:3000   (login at /login)
      - Customer mobile    -> http://localhost:3100
      - Pharmacy mobile    -> http://localhost:3200
      - Rider mobile       -> http://localhost:3300
  6. Auto-restarts any service that crashes (no full-suite shutdown) and
     reprints a live status summary as each app becomes ready.
  7. Ctrl+C cleanly stops all.

Requirements on PATH: python (3.11+), node, npm.
SQLite is used by default — no Docker needed.

──────────────────────────────────────────────────────────────────────────────
Dev ↔ Production mode router
──────────────────────────────────────────────────────────────────────────────
This launcher is the single entry point for both local edit/iterate cycles
and pushing the current workspace live. Pick a mode with a flag (default is
local dev — backwards compatible with prior usage):

    python run.py                      # local dev (workspace → localhost)
    python run.py --prod               # deploy current workspace to live VPS
    python run.py --prod -- --restart all  # forward extra args to deploy.py
    python run.py --status             # HEAD-probe all 6 live hostnames

`--prod` shells out to deploy.py (proven SSH push + NSSM-restart pipeline),
so the production wiring stays in exactly one place. `--status` is a local
convenience that needs no extra deps.

The admin cockpit is NOT part of this launcher: it is the web Admin Console
served by the backend itself at http://localhost:8000/admin (production:
https://admin.medidoor.com.bd/admin). The old Tkinter `admin.py` desktop tool
was retired — see knowledge.md §8.
"""
from __future__ import annotations

import argparse
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

# Windows consoles default to cp1252 which cannot print ✓ — without this the
# --status command crashes (exit 1) right after reporting all-healthy.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
MOBILE_CUSTOMER = ROOT / "mobile-customer"
MOBILE_PHARMACY = ROOT / "mobile-pharmacy"
MOBILE_RIDER = ROOT / "mobile-rider"
VENV_DIR = BACKEND / ".venv"
RUNTIME_ROOT = ROOT / ".medidoor-runtime"
IS_WINDOWS = os.name == "nt"
SERVICE_PORTS = {
    "backend": 8000,
    "website": 3000,
    "customer mobile": 3100,
    "pharmacy mobile": 3200,
    "rider mobile": 3300,
}
DEV_PORTS = list(SERVICE_PORTS.values())

# ANSI colours for prefixed log lines.
C_BACK = "\033[36m"   # cyan
C_FRONT = "\033[35m"  # magenta
C_CUST = "\033[34m"   # blue
C_PHARM = "\033[33m"  # yellow
C_RIDER = "\033[95m"  # bright magenta
C_INFO = "\033[32m"   # green
C_WARN = "\033[33m"   # yellow
C_ERR = "\033[31m"    # red
C_OFF = "\033[0m"
VERBOSE = os.environ.get("MEDIDOOR_RUN_VERBOSE") in ("1", "true", "True")
NEXT_ENV_FALLBACK = "NEXT_PUBLIC_API_URL=http://localhost:8000\nNEXT_PUBLIC_BARIKOI_KEY=\n"


# --------------------------------------------------------------------------- #
# Pretty logging
# --------------------------------------------------------------------------- #


def info(msg: str) -> None:
    print(f"{C_INFO}[run]{C_OFF} {msg}", flush=True)


def detail(msg: str) -> None:
    if VERBOSE:
        info(msg)


def warn(msg: str) -> None:
    print(f"{C_WARN}[run]{C_OFF} {msg}", flush=True)


def err(msg: str) -> None:
    print(f"{C_ERR}[run]{C_OFF} {msg}", flush=True)


def die(msg: str, code: int = 1) -> None:
    err(msg)
    sys.exit(code)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def venv_python() -> Path:
    return VENV_DIR / ("Scripts" if IS_WINDOWS else "bin") / ("python.exe" if IS_WINDOWS else "python")


def _candidate_node_dirs() -> list[Path]:
    """Common Node.js install locations on Windows (in case PATH wasn't refreshed)."""
    dirs: list[Path] = []
    if IS_WINDOWS:
        for env_key in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            base = os.environ.get(env_key)
            if base:
                dirs.append(Path(base) / "nodejs")
        appdata = os.environ.get("APPDATA")
        if appdata:
            dirs.append(Path(appdata) / "npm")
    return [d for d in dirs if d.exists()]


def find_npm() -> str:
    """Locate npm. On Windows it's usually `npm.cmd`."""
    names = ("npm.cmd", "npm.exe", "npm") if IS_WINDOWS else ("npm",)
    for name in names:
        path = shutil.which(name)
        if path:
            return path
    for d in _candidate_node_dirs():
        for name in names:
            cand = d / name
            if cand.exists():
                return str(cand)
    die("`npm` not found on PATH. Install Node.js LTS from https://nodejs.org/ then open a new terminal.")
    return ""  # unreachable


def find_node() -> str:
    names = ("node.exe", "node") if IS_WINDOWS else ("node",)
    for name in names:
        path = shutil.which(name)
        if path:
            return path
    for d in _candidate_node_dirs():
        for name in names:
            cand = d / name
            if cand.exists():
                # Also push this dir onto PATH so npm scripts can find node.
                os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
                return str(cand)
    die("`node` not found on PATH. Install Node.js LTS from https://nodejs.org/ then open a new terminal.")
    return ""  # unreachable


def ensure_backend_env() -> None:
    """Create backend/.env from example and inject a fresh SECRET_KEY."""
    env_path = BACKEND / ".env"
    example = BACKEND / ".env.example"

    if not env_path.exists():
        if not example.exists():
            die(f"Missing {example}")
        text = example.read_text(encoding="utf-8")
        text = re.sub(
            r"^SECRET_KEY=.*$",
            f"SECRET_KEY={secrets.token_urlsafe(64)}",
            text,
            flags=re.MULTILINE,
        )
        env_path.write_text(text, encoding="utf-8")
        info(f"Created {env_path.relative_to(ROOT)} (random SECRET_KEY generated).")
    else:
        text = env_path.read_text(encoding="utf-8")
        if "CHANGE_ME" in text:
            text = re.sub(
                r"^SECRET_KEY=.*$",
                f"SECRET_KEY={secrets.token_urlsafe(64)}",
                text,
                flags=re.MULTILINE,
            )
            env_path.write_text(text, encoding="utf-8")
            info("Replaced placeholder SECRET_KEY in backend/.env.")

    if "PASTE_YOUR_GOOGLE_CLIENT_SECRET_HERE" in env_path.read_text(encoding="utf-8"):
        warn("backend/.env: GOOGLE_CLIENT_SECRET is still a placeholder.")
        warn("  Get it from https://console.cloud.google.com/apis/credentials")
        warn("  then replace the value in backend/.env. Google sign-in will fail until you do.")


def ensure_next_env(app_dir: Path) -> bool:
    env_path = app_dir / ".env.local"
    examples = [app_dir / ".env.local.example", app_dir / ".env.example"]
    try:
        if env_path.exists():
            return True
    except OSError as exc:
        rel = env_path.relative_to(ROOT)
        warn(f"Cannot read {rel}: {exc}")
        warn(f"Trying to recreate {rel} from a clean template ...")
        try:
            env_path.unlink(missing_ok=True)
        except OSError as unlink_exc:
            warn(f"Could not delete unreadable {rel}: {unlink_exc}")
    for example in examples:
        try:
            if example.exists():
                env_path.write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
                info(f"Created {env_path.relative_to(ROOT)}.")
                return True
        except OSError as exc:
            warn(f"Skipping unreadable {example.relative_to(ROOT)}: {exc}")
    try:
        env_path.write_text(NEXT_ENV_FALLBACK, encoding="utf-8")
        info(f"Created {env_path.relative_to(ROOT)} with default local API settings.")
        return True
    except OSError as exc:
        warn(f"Could not create {env_path.relative_to(ROOT)}: {exc}")
        return False


def prepare_runtime_next_app(app_dir: Path, label: str) -> Path:
    """Create a clean launch copy when the real app dir has bad dotfiles.

    This keeps `python run.py` useful even if Windows refuses to read/delete a
    stuck `.env.local` entry. Source/config files are copied fresh each launch;
    `node_modules` is left in the runtime dir between runs for speed.
    """
    runtime_dir = RUNTIME_ROOT / app_dir.name
    runtime_dir.mkdir(parents=True, exist_ok=True)

    for folder_name in ("src", "public"):
        src = app_dir / folder_name
        dst = runtime_dir / folder_name
        if dst.exists():
            shutil.rmtree(dst, ignore_errors=True)
        if src.exists():
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns(".next", ".turbo", "node_modules"))

    for file_name in (
        "next-env.d.ts",
        "next.config.js",
        "package-lock.json",
        "package.json",
        "postcss.config.js",
        "tailwind.config.js",
        "tsconfig.json",
    ):
        src = app_dir / file_name
        if src.exists():
            shutil.copy2(src, runtime_dir / file_name)

    (runtime_dir / ".env.local").write_text(NEXT_ENV_FALLBACK, encoding="utf-8")
    (runtime_dir / ".env.local.example").write_text(NEXT_ENV_FALLBACK, encoding="utf-8")
    warn(
        f"Using clean runtime copy for {label}: {runtime_dir.relative_to(ROOT)}. "
        "Restart run.py after editing this app while the original dotfiles remain unreadable."
    )
    return runtime_dir


def ensure_venv() -> None:
    if not venv_python().exists():
        info("Creating Python virtualenv at backend/.venv ...")
        rc = subprocess.call([sys.executable, "-m", "venv", str(VENV_DIR)])
        if rc != 0:
            die("Failed to create virtualenv.")


def pip_install_if_needed() -> None:
    """Install requirements only when the lock-marker is older than requirements.txt."""
    req = BACKEND / "requirements.txt"
    marker = VENV_DIR / ".requirements.installed"
    if marker.exists() and marker.stat().st_mtime >= req.stat().st_mtime:
        return
    info("Installing Python dependencies (this can take a minute the first time) ...")
    rc = subprocess.call(
        [str(venv_python()), "-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", str(req)]
    )
    if rc != 0:
        die("pip install failed.")
    marker.write_text("ok", encoding="utf-8")


def npm_install_if_needed(app_dir: Path, label: str) -> None:
    if (app_dir / "node_modules").exists():
        return
    info(f"Installing {label} dependencies (npm install) — first run only ...")
    npm = find_npm()
    rc = subprocess.call([npm, "install", "--no-audit", "--no-fund"], cwd=str(app_dir))
    if rc != 0:
        die(f"npm install failed for {label}.")


def wipe_next_cache(app_dir: Path) -> None:
    """Delete every Next.js / SWC / Turbo / TypeScript cache so the dev server
    recompiles from scratch — guarantees `Ctrl+R` in the browser always shows
    the latest code instead of a stale chunk that 404s or returns yesterday's
    build."""
    rm_dirs = [
        app_dir / ".next",
        app_dir / ".turbo",
        app_dir / ".swc",
        app_dir / "node_modules" / ".cache",
    ]
    for t in rm_dirs:
        if t.exists():
            try:
                shutil.rmtree(t, ignore_errors=True)
                detail(f"Cleared cache: {t.relative_to(ROOT)}")
            except Exception as e:  # noqa: BLE001
                warn(f"Could not delete {t}: {e}")
    # tsbuildinfo files are tiny but they keep stale type checks alive.
    for tsi in app_dir.glob("*.tsbuildinfo"):
        try:
            tsi.unlink()
            detail(f"Cleared cache: {tsi.relative_to(ROOT)}")
        except Exception:  # noqa: BLE001
            pass


def wipe_python_cache(folder: Path) -> None:
    """Drop __pycache__ trees under `folder` so freshly-edited .py files don't
    silently keep running their old .pyc copy after a partial reload."""
    if not folder.exists():
        return
    for cache_dir in folder.rglob("__pycache__"):
        try:
            shutil.rmtree(cache_dir, ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------- #
# Process management
# --------------------------------------------------------------------------- #


_READY_PATTERNS = (
    re.compile(r"ready in", re.IGNORECASE),
    re.compile(r"compiled .*successfully", re.IGNORECASE),
    re.compile(r"started server on", re.IGNORECASE),
    re.compile(r"uvicorn running on", re.IGNORECASE),
    re.compile(r"application startup complete", re.IGNORECASE),
)


def stream_output(
    proc: subprocess.Popen,
    prefix: str,
    color: str,
    on_ready: "callable | None" = None,
) -> None:
    assert proc.stdout is not None
    fired_ready = False
    for line in iter(proc.stdout.readline, ""):
        if not line:
            break
        sys.stdout.write(f"{color}[{prefix}]{C_OFF} {line.rstrip()}\n")
        sys.stdout.flush()
        if not fired_ready and on_ready is not None:
            for pat in _READY_PATTERNS:
                if pat.search(line):
                    fired_ready = True
                    try:
                        on_ready()
                    except Exception:  # noqa: BLE001
                        pass
                    break


def spawn(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> subprocess.Popen:
    creationflags = 0
    if IS_WINDOWS:
        # CREATE_NEW_PROCESS_GROUP so we can deliver CTRL_BREAK_EVENT to children.
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    return subprocess.Popen(
        cmd,
        cwd=str(cwd),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        creationflags=creationflags,
    )


def stop(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        if IS_WINDOWS:
            proc.send_signal(signal.CTRL_BREAK_EVENT)  # type: ignore[attr-defined]
        else:
            proc.terminate()
        try:
            proc.wait(timeout=6)
        except subprocess.TimeoutExpired:
            if IS_WINDOWS:
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/F", "/T"],
                    capture_output=True,
                    timeout=8,
                )
            else:
                proc.kill()
    except Exception:
        try:
            if IS_WINDOWS:
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/F", "/T"],
                    capture_output=True,
                    timeout=8,
                )
            else:
                proc.kill()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def free_port(port: int) -> None:
    """Kill any process currently listening on `port`.

    Re-running `run.py` after a hard kill (or after closing the terminal
    without graceful shutdown) often leaves a Node / uvicorn worker still
    holding the port, so the next start crashes with EADDRINUSE. We pre-empt
    that by walking the listeners and stopping them before we spawn.
    """
    try:
        if IS_WINDOWS:
            # Use PowerShell — Get-NetTCPConnection is the most reliable way
            # to map a TCP port to its owning PID without parsing netstat.
            ps = (
                f"$c = Get-NetTCPConnection -LocalPort {port} -State Listen "
                f"-ErrorAction SilentlyContinue; "
                f"foreach ($x in $c) {{ $x.OwningProcess }}"
            )
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps],
                capture_output=True, text=True, timeout=5,
            )
            pids = {p.strip() for p in out.stdout.splitlines() if p.strip().isdigit()}
        else:
            out = subprocess.run(
                ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
                capture_output=True, text=True, timeout=5,
            )
            pids = {p.strip() for p in out.stdout.splitlines() if p.strip().isdigit()}
        for pid in pids:
            detail(f"Port {port} held by PID {pid} — killing stale process")
            try:
                if IS_WINDOWS:
                    subprocess.run(
                        ["taskkill", "/PID", pid, "/F", "/T"],
                        capture_output=True, timeout=5,
                    )
                else:
                    os.kill(int(pid), signal.SIGKILL)
            except Exception:
                pass
    except Exception as exc:
        warn(f"Could not check port {port}: {exc}")


def free_dev_ports(ports: list[int]) -> None:
    for p in ports:
        free_port(p)
    # Sockets need a brief moment to be released after the owning process dies.
    time.sleep(0.5)


# ─────────────────── prod-mode helpers ────────────────────
# These keep all dev/prod plumbing inside this single launcher. `deploy.py`
# remains the single source of truth for what "production-ready" means
# (build envs, SSH push, NSSM restart, smoke tests); the helpers below just
# wrap it and add a quick local convenience (live status probe).
LIVE_HOSTNAMES = (
    ("api",      "https://api.medidoor.com.bd/health"),
    ("website",  "https://medidoor.com.bd/"),
    ("www",      "https://www.medidoor.com.bd/"),
    ("customer", "https://customer.medidoor.com.bd/"),
    ("pharmacy", "https://pharmacy.medidoor.com.bd/"),
    ("rider",    "https://rider.medidoor.com.bd/"),
)
_PROBE_UA = "MediDoor-Launcher/1.0 (+https://medidoor.com.bd)"
_PROBE_TIMEOUT = 10


def _run_prod_deploy(extras: list[str]) -> None:
    """Forward to deploy.py — proven SSH push + build + NSSM-restart pipeline."""
    deploy_script = ROOT / "deploy.py"
    if not deploy_script.exists():
        die(f"Missing {deploy_script.relative_to(ROOT)} — production wiring unavailable.")
    forward = list(extras or [])
    # argparse.REMAINDER keeps the literal `--` separator; strip it so deploy.py
    # doesn't see a stray token.
    if forward and forward[0] == "--":
        forward = forward[1:]
    cmd = [sys.executable, str(deploy_script), *forward]
    info("Prod deploy mode — handing off to deploy.py ...")
    detail(f"  cmd: {' '.join(cmd)}")
    rc = subprocess.call(cmd, cwd=str(ROOT))
    if rc != 0:
        die(f"deploy.py exited with code {rc}.", rc)
    info(f"{C_INFO}✓ deploy.py finished cleanly.{C_OFF}")


def _run_status_check() -> None:
    """HEAD/GET probe of the 6 live hostnames. Browser-style UA so Cloudflare
    doesn't 403 the launcher itself."""
    info(f"Status check against live MediDoor hostnames (UA={_PROBE_UA!r}):")
    failed = 0
    for label, url in LIVE_HOSTNAMES:
        try:
            req = urllib.request.Request(url, method="GET", headers={"User-Agent": _PROBE_UA})
            with urllib.request.urlopen(req, timeout=_PROBE_TIMEOUT) as resp:
                code = resp.status
            color = C_INFO if 200 <= code < 400 else C_WARN
            info(f"  [{color}{code:>3}{C_OFF}] {label:<9} {url}")
        except urllib.error.HTTPError as exc:
            color = C_WARN if exc.code < 500 else C_ERR
            info(f"  [{color}{exc.code:>3}{C_OFF}] {label:<9} {url}")
            failed += 1
        except Exception as exc:  # noqa: BLE001
            info(f"  [{C_ERR}ERR{C_OFF}] {label:<9} {url}  -> {type(exc).__name__}: {exc}")
            failed += 1
    if failed:
        warn(f"{failed}/{len(LIVE_HOSTNAMES)} hostnames failed.")
        sys.exit(1)
    info(f"{C_INFO}✓ all {len(LIVE_HOSTNAMES)} hostnames healthy.{C_OFF}")


def main() -> None:
    if IS_WINDOWS:
        # Enable ANSI in older terminals.
        os.system("")

    # ─────────────────── mode router ────────────────────
    # Default mode = local dev (preserve prior `python run.py` behaviour).
    # `--prod` / `--deploy` forwards to deploy.py; `--status` health-checks
    # live hostnames.
    parser = argparse.ArgumentParser(
        prog="run.py",
        add_help=True,
        description="MediDoor launcher — local dev by default, or deploy/status.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prod", "--deploy", dest="prod", action="store_true",
                      help="Deploy current workspace to live VPS via deploy.py.")
    mode.add_argument("--status", dest="status", action="store_true",
                      help="HEAD-probe the 6 live medidoor.com.bd hostnames.")
    parser.add_argument("extras", nargs=argparse.REMAINDER,
                        help="Extra args forwarded to deploy.py when using --prod.")
    args = parser.parse_args()

    if args.prod:
        info(f"{C_WARN}=== MODE: PRODUCTION DEPLOY ==={C_OFF}")
        info("This will push the current workspace to the live VPS and rebuild")
        info("the public sites. Local dev stack is NOT started.")
        return _run_prod_deploy(args.extras)
    if args.status:
        info(f"{C_INFO}=== MODE: LIVE STATUS CHECK ==={C_OFF}")
        return _run_status_check()
    info(f"{C_INFO}=== MODE: LOCAL DEV (workspace -> localhost) ==={C_OFF}")
    info("Production on api.medidoor.com.bd is NOT touched. Use")
    info("`python run.py --prod` to deploy when you are ready.")
    info("MediDoor starting ...")
    detail(f"Repo root: {ROOT}")

    if sys.version_info < (3, 11):
        die(f"Python 3.11+ required, got {sys.version.split()[0]}")

    find_node()  # validates node is installed
    ensure_backend_env()
    next_app_sources = [
        (FRONTEND, "website"),
        (MOBILE_CUSTOMER, "customer mobile"),
        (MOBILE_PHARMACY, "pharmacy mobile"),
        (MOBILE_RIDER, "rider mobile"),
    ]
    next_apps: list[tuple[Path, str]] = []
    next_app_dirs: dict[str, Path] = {}
    for app_dir, label in next_app_sources:
        if not app_dir.exists():
            die(f"Missing Next app folder: {app_dir.relative_to(ROOT)}")
        runtime_dir = app_dir if ensure_next_env(app_dir) else prepare_runtime_next_app(app_dir, label)
        next_apps.append((runtime_dir, label))
        next_app_dirs[label] = runtime_dir
    ensure_venv()
    pip_install_if_needed()
    info("Fresh code mode: clearing old app caches ...")
    for app_dir, label in next_apps:
        npm_install_if_needed(app_dir, label)
        wipe_next_cache(app_dir)

    backend_cmd = [
        str(venv_python()),
        "-m",
        "uvicorn",
        "app.main:app",
        "--reload",
        "--reload-dir",
        str(BACKEND / "app"),
        "--host",
        "127.0.0.1",
        "--port",
        "8000",
    ]
    npm = find_npm()
    frontend_cmd = [npm, "run", "dev"]
    mobile_customer_cmd = [npm, "run", "dev"]
    mobile_pharmacy_cmd = [npm, "run", "dev"]
    mobile_rider_cmd = [npm, "run", "dev"]

    # Drop stale __pycache__ before launch so backend hot-reload doesn't import
    # an out-of-date .pyc on its first request.
    wipe_python_cache(BACKEND / "app")

    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    env.setdefault("FORCE_COLOR", "1")
    # Force Python to NEVER write .pyc to disk — every reload reads the .py
    # source, so a stale cache can't mask a backend edit.
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    services = [
        ("backend", "back", C_BACK, backend_cmd, BACKEND, "http://localhost:8000  (Swagger: /docs)"),
        ("website", "site", C_FRONT, frontend_cmd, next_app_dirs["website"], "http://localhost:3000  (login: /login)"),
        ("customer mobile", "cust", C_CUST, mobile_customer_cmd, next_app_dirs["customer mobile"], "http://localhost:3100"),
        ("pharmacy mobile", "pharm", C_PHARM, mobile_pharmacy_cmd, next_app_dirs["pharmacy mobile"], "http://localhost:3200"),
        ("rider mobile", "rider", C_RIDER, mobile_rider_cmd, next_app_dirs["rider mobile"], "http://localhost:3300"),
    ]

    processes: dict[str, subprocess.Popen] = {}
    ready_state: dict[str, bool] = {}
    restart_counts: dict[str, int] = {}
    service_by_name: dict[str, tuple] = {s[0]: s for s in services}
    summary_lock = threading.Lock()

    def print_summary() -> None:
        with summary_lock:
            info("Apps status:")
            for name, _prefix, _color, _cmd, _cwd, url in services:
                proc = processes.get(name)
                if proc is None or proc.poll() is not None:
                    tag = f"{C_ERR}DOWN{C_OFF}"
                elif ready_state.get(name):
                    tag = f"{C_INFO}READY{C_OFF}"
                else:
                    tag = f"{C_WARN}starting{C_OFF}"
                info(f"  [{tag}] {name:<16} {url}")

    def make_ready_cb(name: str):
        def _cb() -> None:
            if ready_state.get(name):
                return
            ready_state[name] = True
            info(f"{C_INFO}✓ {name} is ready.{C_OFF}")
            print_summary()
        return _cb

    def launch(name: str) -> None:
        _name, prefix, color, cmd, cwd, url = service_by_name[name]
        # Free its port (in case the previous instance is still holding it).
        port = SERVICE_PORTS.get(name)
        if port:
            free_port(port)
        detail(f"Starting {name:<15} -> {url}")
        proc = spawn(cmd, cwd, env=env)
        processes[name] = proc
        ready_state[name] = False
        threading.Thread(
            target=stream_output,
            args=(proc, prefix, color, make_ready_cb(name)),
            daemon=True,
        ).start()

    # Pre-empt EADDRINUSE crashes from leftover processes from a previous run.
    free_dev_ports(DEV_PORTS)
    for name, *_ in services:
        launch(name)

    info("Apps are starting:")
    info("  Website          http://localhost:3000")
    info("  Customer mobile  http://localhost:3100")
    info("  Pharmacy mobile  http://localhost:3200")
    info("  Rider mobile     http://localhost:3300")
    info("  Admin console    http://localhost:8000/admin")
    info("Press Ctrl+C to stop. (Crashed services auto-restart.)")

    MAX_RESTARTS = int(os.environ.get("MEDIDOOR_MAX_RESTARTS", "20"))
    RESTART_BACKOFF_SEC = float(os.environ.get("MEDIDOOR_RESTART_BACKOFF", "2.0"))
    last_summary = time.time()
    SUMMARY_EVERY_SEC = float(os.environ.get("MEDIDOOR_SUMMARY_EVERY", "30"))

    try:
        while True:
            time.sleep(0.5)
            now = time.time()
            for name, *_ in services:
                proc = processes.get(name)
                if proc is None:
                    continue
                if proc.poll() is None:
                    continue
                # Process exited — auto-restart instead of killing the suite.
                code = proc.returncode
                count = restart_counts.get(name, 0) + 1
                restart_counts[name] = count
                if count > MAX_RESTARTS:
                    err(f"{name} crashed too many times ({count}). Giving up on it.")
                    processes.pop(name, None)
                    continue
                warn(
                    f"{name} exited (code {code}) — auto-restarting "
                    f"(attempt {count}/{MAX_RESTARTS}) ..."
                )
                time.sleep(RESTART_BACKOFF_SEC)
                launch(name)
                print_summary()
                last_summary = time.time()
            if now - last_summary >= SUMMARY_EVERY_SEC:
                print_summary()
                last_summary = now
    except KeyboardInterrupt:
        info("Ctrl+C received — stopping servers ...")
        for _name, proc in list(processes.items())[::-1]:
            stop(proc)
        info("Goodbye.")


if __name__ == "__main__":
    main()
