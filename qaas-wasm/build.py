#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["packaging>=24"]
# ///
"""Build the extension's WebAssembly runtime (wasm/): qaas + its dependency closure for Pyodide.

    uv run --python 3.13 qaas-wasm/build.py status                 # bundled vs. latest qaas / Pyodide
    uv run --python 3.13 qaas-wasm/build.py build                  # latest qaas release (pre-releases too)
    uv run --python 3.13 qaas-wasm/build.py build --qaas v1.2.0 --pyodide 0.29.3
    uv run --python 3.13 qaas-wasm/build.py assemble --wheelhouse DIR   # only re-assemble wasm/
    npm run wasm:test                                               # smoke test of wasm/

Steps of `build`:
  1. qaas from its GitHub release tag, as a wheel (requires-python widened to Pyodide's Python).
  2. Dependency closure of qaas[<extra>] with uv. Packages with no pure-Python wheel that Pyodide
     ships are pinned to Pyodide's builds; packages whose PyPI requirements do not accept those
     versions are moved to older releases. Packages the bridge never imports are replaced by
     placeholders (MOCKED) or stubs (STUBS).
  3. Pure-Python wheels from PyPI; every other package is compiled for wasm32 with pyodide-build
     (sdist + emscripten + Rust from conda-forge), with the crate patches in build-recipe/patches.
     Compiled wheels are cached per Pyodide version, so qiskit is only rebuilt when it changes.
  4. wasm/ = manifest.json + wheels/ + the Pyodide files those packages need (verified by sha256).
  5. Smoke test through the extension's worker (node qaas-wasm/smoke-test.mjs).

Needs: git, uv, node >= 24, network (GitHub, PyPI, crates.io, conda-forge, jsDelivr). micromamba is
downloaded when missing. Runs on macOS (arm64/x86_64) and Linux (x86_64; conda-forge has no
linux-aarch64 emscripten). Cache: $QAAS_WASM_CACHE or ~/.cache/qaas-wasm (several GB with Rust).
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from datetime import UTC, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
RECIPE = HERE / "build-recipe"
OUT = REPO / "wasm"
CACHE = Path(os.environ.get("QAAS_WASM_CACHE") or Path.home() / ".cache" / "qaas-wasm")

QAAS_REPO = "It4innovations/quantum-as-a-service"
DEFAULT_PYODIDE = "0.29.3"
DEFAULT_EXTRA = "iqm_qiskit"  # matches the extension's default qaas.packageExtra
# Not importable in Pyodide and never imported by the bridge; micropip placeholders keep the
# metadata of packages that declare them as dependencies consistent.
MOCKED = ("py4lexis", "grpcio", "symengine", "scipy-stubs", "psutil")
# Imported at qaas import time; replaced by our own wheels.
STUBS = {"qiskit-aer": RECIPE / "stubs" / "qiskit_aer_stub"}
ADAPTER = RECIPE / "stubs" / "qaas_pyodide"
# Pyodide stdlib modules loaded in addition to the dependency closure.
ALWAYS_LOAD = ("ssl",)
# Toolchain for compiled packages (emscripten comes from the Pyodide cross-build environment).
RUST_VERSION = "1.97.0"
BINARYEN_VERSION = "121"  # emscripten's conda pin (117) lacks --no-stack-ir
PYODIDE_BUILD = "pyodide-build>=0.30"
PYODIDE_CORE = (
    "pyodide.mjs",
    "pyodide.js",
    "pyodide.asm.js",
    "pyodide.asm.wasm",
    "python_stdlib.zip",
    "pyodide-lock.json",
    "package.json",
)


# ------------------------------------------------------------------------------------- helpers


def say(msg: str) -> None:
    print(f"\033[1m==> {msg}\033[0m", flush=True)


def run(
    cmd: list, *, cwd: Path | None = None, env: dict | None = None, capture: bool = False, check: bool = True
) -> str | None:
    print("   $", " ".join(str(c) for c in cmd), flush=True)
    res = subprocess.run(
        [str(c) for c in cmd],
        cwd=cwd,
        env={**os.environ, **(env or {})},
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    if res.returncode:
        if not check:
            return None
        sys.exit(f"command failed ({res.returncode}): {' '.join(str(c) for c in cmd)}")
    return res.stdout or ""


def fetch(url: str, dest: Path | None = None) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "qaas-wasm-build"})
    token = os.environ.get("GITHUB_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        req.add_header("Authorization", f"Bearer {token}")
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            break
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == 3:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == 3:
                raise
        time.sleep(2**attempt)
    if dest:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        tmp.write_bytes(data)
        tmp.replace(dest)
    return data


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canon(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


_pypi: dict[tuple[str, str], dict] = {}


def pypi_release(name: str, version: str) -> dict:
    key = (name, version)
    if key not in _pypi:
        _pypi[key] = json.loads(fetch(f"https://pypi.org/pypi/{name}/{version}/json"))
    return _pypi[key]


def prefetch_pypi(pins: list[tuple[str, str]]) -> None:
    """Fetch the PyPI metadata of many releases in parallel (the checks below read it one by one)."""
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(16) as pool:
        list(pool.map(lambda p: pypi_release(*p), [p for p in pins if p not in _pypi and p[0] != "qaas"]))


def pypi_files(name: str, version: str) -> list[dict]:
    """Files of a release on PyPI (filename, url, digests, packagetype)."""
    return pypi_release(name, version)["urls"]


def wheel_requires(wheel: Path) -> list[str]:
    with zipfile.ZipFile(wheel) as z:
        meta = z.read(next(n for n in z.namelist() if n.endswith(".dist-info/METADATA"))).decode()
    return re.findall(r"^Requires-Dist: (.+)$", meta, re.M)


PURE_WHEEL = re.compile(r"-[\w.]*py3[\w.]*-none-any\.whl$")  # py3, py2.py3, py312 ... -none-any


def pure_wheel(name: str, version: str) -> dict | None:
    return next((f for f in pypi_files(name, version) if PURE_WHEEL.search(f["filename"])), None)


def download_verified(f: dict, dest_dir: Path) -> Path:
    dest = dest_dir / f["filename"]
    fetch(f["url"], dest)
    if sha256(dest) != f["digests"]["sha256"]:
        dest.unlink()
        sys.exit(f"sha256 mismatch for {f['filename']} from PyPI")
    return dest


def wheel_name_version(filename: str) -> tuple[str, str]:
    parts = filename.split("-")
    return canon(parts[0]), parts[1]


# ------------------------------------------------------------------------------ release lookup


def latest_qaas(stable: bool) -> str:
    releases = json.loads(fetch(f"https://api.github.com/repos/{QAAS_REPO}/releases?per_page=30"))
    for r in releases:
        if not r["draft"] and not (stable and r["prerelease"]):
            return r["tag_name"]
    sys.exit(f"no release found in {QAAS_REPO}")


def latest_pyodide() -> str:
    return json.loads(fetch("https://api.github.com/repos/pyodide/pyodide/releases/latest"))["tag_name"]


def status(_: argparse.Namespace) -> None:
    manifest = OUT / "manifest.json"
    if manifest.exists():
        m = json.loads(manifest.read_text())
        ref, built = m.get("qaas_ref", "?"), m.get("built", "?")
        print(f"bundled:  qaas {m['qaas_version']} ({ref}), Pyodide {m['pyodide_version']}, built {built}")
    else:
        print(f"bundled:  none ({manifest} missing)")
    print(f"latest:   qaas {latest_qaas(False)} (stable: {latest_qaas(True)}), Pyodide {latest_pyodide()}")
    print("A new Pyodide minor version can change the Python version and the packages it ships;")
    print("build with --pyodide <version> to try it.")


# ------------------------------------------------------------------------------------- Pyodide


class PyodideDist:
    """Pyodide core from the GitHub release; packages from jsDelivr on demand, verified by the lock's sha256."""

    def __init__(self, version: str):
        self.version = version
        self.dir = CACHE / f"pyodide-{version}"
        lock = self.dir / "pyodide-lock.json"
        if not lock.exists():
            say(f"Downloading Pyodide {version} core")
            url = f"https://github.com/pyodide/pyodide/releases/download/{version}/pyodide-core-{version}.tar.bz2"
            with tarfile.open(fileobj=io.BytesIO(fetch(url)), mode="r:bz2") as tar:
                tmp = Path(tempfile.mkdtemp(dir=CACHE))
                tar.extractall(tmp, filter="data")
                shutil.rmtree(self.dir, ignore_errors=True)
                (tmp / "pyodide").rename(self.dir)
                shutil.rmtree(tmp)
        self.lock = json.loads(lock.read_text())
        self.packages = self.lock["packages"]
        self.python = self.lock["info"]["python"]  # e.g. 3.13.2
        tags = {m.group(1) for p in self.packages.values() if (m := re.search(r"-(\w+_wasm32)\.whl$", p["file_name"]))}
        if len(tags) != 1:
            sys.exit(f"cannot tell Pyodide's wheel platform tag: {sorted(tags)}")
        self.platform_tag = tags.pop()

    def native(self) -> dict[str, str]:
        """{canonical name: version} of the compiled packages Pyodide ships."""
        return {
            canon(p["name"]): p["version"]
            for p in self.packages.values()
            if p["file_name"].endswith("wasm32.whl") and p.get("package_type", "package") == "package"
        }

    def key(self, name: str) -> str:
        """Lock key for a package name (keys are not always canonical)."""
        for key, p in self.packages.items():
            if canon(p["name"]) == canon(name) or canon(key) == canon(name):
                return key
        raise KeyError(name)

    def closure(self, names: list[str]) -> list[str]:
        todo, seen = [self.key(n) for n in names], set()
        while todo:
            k = todo.pop()
            if k not in seen:
                seen.add(k)
                todo += [self.key(d) for d in self.packages[k].get("depends", [])]
        return sorted(seen)

    def file(self, key: str) -> Path:
        p = self.packages[key]
        path = self.dir / p["file_name"]
        if not path.exists() or sha256(path) != p["sha256"]:
            fetch(f"https://cdn.jsdelivr.net/pyodide/v{self.version}/full/{p['file_name']}", path)
            if sha256(path) != p["sha256"]:
                path.unlink()
                sys.exit(f"sha256 mismatch for {p['file_name']} from jsDelivr")
        return path


# ------------------------------------------------------------------------------------ toolchain


class Toolchain:
    """pyodide-build venv (always) and emscripten + Rust from conda-forge (only for compiled packages)."""

    def __init__(self, dist: PyodideDist):
        self.dist = dist
        self.venv = CACHE / "toolchain" / f"pyodide-build-{dist.version}"
        self.bin = self.venv / ("Scripts" if os.name == "nt" else "bin")
        self.env = {"PYODIDE_XBUILDENV_PATH": str(CACHE / "xbuildenv"), "CARGO_HOME": str(CACHE / "cargo")}
        if not (self.bin / "pyodide").exists():
            say("Creating the pyodide-build environment")
            run(["uv", "venv", "--python", "3.13", self.venv])
            run(["uv", "pip", "install", "--python", self.bin / "python", PYODIDE_BUILD])
        self._native_env: dict | None = None

    def native_env(self) -> dict:
        if self._native_env is not None:
            return self._native_env
        run([self.bin / "pyodide", "xbuildenv", "install", self.dist.version], env=self.env)
        emver = run([self.bin / "pyodide", "config", "get", "emscripten_version"], env=self.env, capture=True).strip()
        mamba = micromamba()
        em = CACHE / "toolchain" / f"emscripten-{emver}-rust-{RUST_VERSION}"
        if not (em / "bin" / "emcc").exists():
            say(f"Installing emscripten {emver} and Rust {RUST_VERSION} (conda-forge)")
            run(
                [
                    mamba,
                    "create",
                    "-y",
                    "-q",
                    "-p",
                    em,
                    "-c",
                    "conda-forge",
                    f"emscripten={emver}",
                    f"rust={RUST_VERSION}",
                    f"rust-std-wasm32-unknown-emscripten={RUST_VERSION}",
                ]
            )
        bn = CACHE / "toolchain" / f"binaryen-{BINARYEN_VERSION}"
        if not (bn / "bin" / "wasm-opt").exists():
            run([mamba, "create", "-y", "-q", "-p", bn, "-c", "conda-forge", f"binaryen={BINARYEN_VERSION}"])
        self._native_env = {
            **self.env,
            "PATH": f"{em / 'bin'}{os.pathsep}{self.bin}{os.pathsep}{os.environ['PATH']}",
            "EM_BINARYEN_ROOT": str(bn),
            "RUSTC_BOOTSTRAP": "1",  # pyodide-build passes -Z flags to stable rustc
        }
        return self._native_env


def micromamba() -> Path:
    found = shutil.which("micromamba")
    if found:
        return Path(found)
    exe = CACHE / "bin" / "micromamba"
    if not exe.exists():
        plat = {
            ("Darwin", "arm64"): "osx-arm64",
            ("Darwin", "x86_64"): "osx-64",
            ("Linux", "x86_64"): "linux-64",
            ("Linux", "aarch64"): "linux-aarch64",
        }.get((platform.system(), platform.machine()))
        if not plat:
            sys.exit(f"no micromamba for {platform.system()} {platform.machine()}; install it and retry")
        say("Downloading micromamba")
        with tarfile.open(
            fileobj=io.BytesIO(fetch(f"https://micro.mamba.pm/api/micromamba/{plat}/latest")), mode="r:bz2"
        ) as tar:
            member = tar.getmember("bin/micromamba")
            exe.parent.mkdir(parents=True, exist_ok=True)
            exe.write_bytes(tar.extractfile(member).read())
        exe.chmod(0o755)
    return exe


# ------------------------------------------------------------------------------- qaas + closure


def build_qaas(ref: str, dist: PyodideDist, wheelhouse: Path) -> Path:
    say(f"qaas {ref}")
    src = CACHE / "src" / f"qaas-{ref}"
    shutil.rmtree(src, ignore_errors=True)
    run(["git", "clone", "-q", "--depth", "1", "--branch", ref, f"https://github.com/{QAAS_REPO}.git", src])
    pyproject = src / "pyproject.toml"
    text = pyproject.read_text()
    minor = int(dist.python.split(".")[1])

    def widen(m: re.Match) -> str:
        # Pyodide's Python may be newer than qaas allows (Pyodide 0.27 was the last 3.12 release).
        return f"<3.{max(int(m.group(1)), minor + 1)}"

    new = re.sub(r"<\s*3\.(\d+)", widen, re.search(r'requires-python\s*=\s*"[^"]*"', text).group(0))
    pyproject.write_text(re.sub(r'requires-python\s*=\s*"[^"]*"', new, text, count=1))
    run(["uv", "build", "--wheel", "-q", "-o", wheelhouse, src])
    return next(wheelhouse.glob("qaas-*.whl"))


def resolve(
    qaas_wheel: Path, extra: str, dist: PyodideDist, work: Path
) -> tuple[list[tuple[str, str]], set[str], dict[str, str]]:
    """Pinned closure [(name, version)], the packages taken from Pyodide, and the mocked packages' versions.

    A package is taken from Pyodide only when PyPI has no pure-Python wheel of the resolved version.
    Its version is then forced (override): Pyodide's builds do not always match PyPI's metadata, e.g.
    Pyodide's cryptography 46 is built with cffi 1.17 while PyPI's requires cffi 2. Forcing hides
    real incompatibilities, so every other package's PyPI requirements are checked against
    Pyodide's versions, and a package that needs newer ones is limited to older releases.
    """
    say(f"Resolving qaas[{extra}] for Python {dist.python}")
    req = work / "requirements.in"
    req.write_text(f"qaas[{extra}] @ {qaas_wheel.as_uri()}\n")
    py = ".".join(dist.python.split(".")[:2])
    native = dist.native()
    excluded = "".join(f"{n} ; sys_platform == 'never'\n" for n in (*MOCKED, *STUBS))
    overrides, constraints = work / "overrides.txt", work / "constraints.txt"

    def compile_(out: Path, check: bool = True) -> list[tuple[str, str]] | None:
        cmd = ["uv", "pip", "compile", req, "--python-version", py, "--python-platform", "linux"]
        cmd += ["--override", overrides, "--constraint", constraints, "--no-header", "--no-annotate", "--quiet"]
        if run([*cmd, "-o", out], check=check) is None:
            return None
        found = re.findall(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;]+)", out.read_text(), re.M)
        return [(canon(n), v) for n, v in found]

    from_pyodide: set[str] = set()
    below: dict[str, str] = {}  # package -> versions below this one
    for _ in range(30):
        pins = "".join(f"{n}=={native[n]}\n" for n in sorted(from_pyodide))
        overrides.write_text(excluded + pins)
        constraints.write_text("".join(f"{n}<{v}\n" for n, v in sorted(below.items())))
        closure = compile_(work / "requirements.lock.txt")
        prefetch_pypi([(n, v) for n, v in closure if n not in MOCKED and n not in STUBS])
        new = {n for n, v in closure if n in native and n not in from_pyodide and not pure_wheel(n, v)}
        if new:
            print(f"   from Pyodide: {', '.join(f'{n}=={native[n]}' for n in sorted(new))}")
            from_pyodide |= new
            continue
        conflicts = pyodide_conflicts(closure, from_pyodide, native, qaas_wheel, extra, py)
        if not conflicts:
            break
        for name, version, why in conflicts:
            if name == "qaas":
                sys.exit(f"qaas needs {why}. Try another Pyodide version (--pyodide).")
            print(f"   {name} {version} requires {why}: trying an older {name}")
            below[name] = version
    else:
        sys.exit("dependency resolution did not settle")
    overrides.write_text(pins)
    full = dict(compile_(work / "full.txt", check=False) or [])
    mocks = {n: full.get(canon(n), "0") for n in MOCKED}
    return closure, from_pyodide, mocks


def pyodide_conflicts(
    closure: list[tuple[str, str]],
    from_pyodide: set[str],
    native: dict[str, str],
    qaas_wheel: Path,
    extra: str,
    py: str,
) -> list[tuple[str, str, str]]:
    """[(package, version, requirement)] whose PyPI requirements reject a version forced to Pyodide's."""
    from packaging.requirements import Requirement
    from packaging.version import Version

    env = {
        "python_version": py,
        "python_full_version": f"{py}.0",
        "sys_platform": "emscripten",
        "platform_system": "Emscripten",
        "platform_machine": "wasm32",
        "os_name": "posix",
        "implementation_name": "cpython",
        "platform_python_implementation": "CPython",
    }
    found = []
    for name, version in closure:
        if name in from_pyodide or name in MOCKED or name in STUBS:
            continue
        if name == "qaas":
            requires, extras = wheel_requires(qaas_wheel), {"", extra}
        else:
            requires, extras = pypi_release(name, version)["info"].get("requires_dist") or [], {""}
        for line in requires:
            r = Requirement(line)
            target = canon(r.name)
            if target not in from_pyodide:
                continue
            if r.marker and not any(r.marker.evaluate({**env, "extra": e}) for e in extras):
                continue
            if not r.specifier.contains(Version(native[target]), prereleases=True):
                found.append((name, version, f"{r.name}{r.specifier}, Pyodide has {native[target]}"))
                break
    return found


# ---------------------------------------------------------------------------- compiled packages


def retag(wheel: Path, tag: str, dest: Path) -> Path:
    """Rename a wasm32 wheel to Pyodide's platform tag (e.g. pyemscripten_2025_0 -> pyodide_2025_0; same ABI)."""
    m = re.search(r"-(\w+_wasm32)\.whl$", wheel.name)
    current = m.group(1) if m else tag  # pure-Python wheel built from an sdist
    target = dest / wheel.name.replace(current, tag)
    if current == tag:
        shutil.copy2(wheel, target)
        return target
    with zipfile.ZipFile(wheel) as zin, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zout:
        files = {i.filename: zin.read(i) for i in zin.infolist()}
        wheel_meta = next(n for n in files if n.endswith(".dist-info/WHEEL"))
        files[wheel_meta] = files[wheel_meta].replace(current.encode(), tag.encode())
        record = next(n for n in files if n.endswith(".dist-info/RECORD"))
        rows = []
        for row in csv.reader(io.StringIO(files[record].decode())):
            if row and row[0] == wheel_meta:
                digest = base64.urlsafe_b64encode(hashlib.sha256(files[wheel_meta]).digest()).rstrip(b"=").decode()
                row = [wheel_meta, f"sha256={digest}", str(len(files[wheel_meta]))]
            rows.append(row)
        buf = io.StringIO()
        csv.writer(buf, lineterminator="\n").writerows(rows)
        files[record] = buf.getvalue().encode()
        for name, data in files.items():
            zout.writestr(name, data)
    return target


def crate_patches() -> list[tuple[str, str, Path]]:
    """[(crate, version, diff)] from build-recipe/patches (paths a/<crate>-<version>/...)."""
    out = []
    for diff in sorted((RECIPE / "patches").glob("*.diff")):
        m = re.search(r"^--- a/([A-Za-z0-9_-]+?)-(\d[\w.+-]*)/", diff.read_text(), re.M)
        if m:
            out.append((m.group(1), m.group(2), diff))
    return out


def patch_crates(project: Path, tc: Toolchain) -> None:
    """Apply crate patches whose crate and version the Rust project locks; warn about stale ones."""
    env = tc.native_env()
    if not (project / "Cargo.lock").exists():
        run(["cargo", "generate-lockfile"], cwd=project, env=env)
    locked = re.findall(r'name = "([^"]+)"\nversion = "([^"]+)"', (project / "Cargo.lock").read_text())
    applied = []
    for crate, version, diff in crate_patches():
        versions = {v for n, v in locked if n == crate}
        if not versions:
            continue
        if version not in versions:
            print(
                f"   ! patch {diff.name} is for {crate} {version}, the project uses {', '.join(sorted(versions))}: "
                "not applied. If the build or transpile fails, port the patch."
            )
            continue
        run(["cargo", "fetch"], cwd=project, env=env)
        registry = next((CACHE / "cargo" / "registry" / "src").glob(f"*/{crate}-{version}"))
        patched = project / "qaas-patches" / f"{crate}-{version}"
        shutil.rmtree(patched, ignore_errors=True)
        shutil.copytree(registry, patched)
        run(["patch", "-p1", "-d", patched.parent, "-i", diff])
        applied.append((crate, version, patched))
    if applied:
        with (project / "Cargo.toml").open("a") as f:
            f.write("\n[patch.crates-io]\n")
            f.writelines(f'{c} = {{ path = "{p}" }}\n' for c, _, p in applied)
        for c, v, _ in applied:
            run(["cargo", "update", "-p", f"{c}@{v}"], cwd=project, env=env)


def build_native(name: str, version: str, tc: Toolchain, dist: PyodideDist, wheelhouse: Path) -> None:
    cached = CACHE / "native" / f"pyodide-{dist.version}" / f"{name}-{version}"
    wheels = list(cached.glob("*.whl")) if cached.exists() else []
    if not wheels:
        say(f"Compiling {name} {version} for wasm32 (this can take a while)")
        env = tc.native_env()
        work = Path(tempfile.mkdtemp(prefix=f"{name}-", dir=CACHE))
        sdist = next((f for f in pypi_files(name, version) if f["packagetype"] == "sdist"), None)
        if not sdist:
            sys.exit(f"{name} {version}: no pure-Python wheel, not in Pyodide {dist.version}, and no sdist on PyPI")
        shutil.unpack_archive(download_verified(sdist, work), work / "src")
        project = next(p for p in (work / "src").iterdir() if p.is_dir())
        if (project / "Cargo.toml").exists():
            patch_crates(project, tc)
        out = work / "dist"
        run([tc.bin / "pyodide", "build", ".", "-o", out], cwd=project, env=env)
        cached.mkdir(parents=True, exist_ok=True)
        for w in out.glob("*.whl"):
            shutil.copy2(w, cached / w.name)
        shutil.rmtree(work, ignore_errors=True)
        wheels = list(cached.glob("*.whl"))
    for w in wheels:
        retag(w, dist.platform_tag, wheelhouse)


def collect(
    closure: list[tuple[str, str]], from_pyodide: set[str], dist: PyodideDist, tc: Toolchain, wheelhouse: Path
) -> list[str]:
    """Put every package of the closure into the wheelhouse; returns the Pyodide packages to load."""
    say(f"Collecting {len(closure)} packages")
    load, to_compile = [], []
    for name, version in closure:
        if name == "qaas":
            continue
        if name in from_pyodide:
            load.append(dist.key(name))
        elif wheel := pure_wheel(name, version):
            download_verified(wheel, wheelhouse)
        else:
            to_compile.append((name, version))
    if to_compile:
        print(f"   to compile: {', '.join(f'{n}=={v}' for n, v in to_compile)}")
    for name, version in to_compile:
        build_native(name, version, tc, dist, wheelhouse)
    for stub in (*STUBS.values(), ADAPTER):
        run(["uv", "build", "--wheel", "-q", "-o", wheelhouse, stub])
    return sorted({*ALWAYS_LOAD, *load})


# ----------------------------------------------------------------------------------- assemble


def assemble(wheelhouse: Path, info: dict, dist: PyodideDist) -> None:
    """wasm/ = manifest.json + wheels/ + the Pyodide files needed to load them."""
    say(f"Assembling {OUT.relative_to(REPO)}/")
    stage = Path(tempfile.mkdtemp(prefix="wasm-", dir=REPO))
    (stage / "wheels").mkdir()
    (stage / "pyodide").mkdir()
    wheels = sorted(p.name for p in wheelhouse.glob("*.whl"))
    seen: dict[str, str] = {}
    for w in wheels:
        name = wheel_name_version(w)[0]
        if name in seen:
            sys.exit(f"two wheels for {name}: {seen[name]} and {w}")
        seen[name] = w
        shutil.copy2(wheelhouse / w, stage / "wheels" / w)
    for name in PYODIDE_CORE:
        if (dist.dir / name).exists():
            shutil.copy2(dist.dir / name, stage / "pyodide" / name)
    for key in dist.closure(["micropip", *info["pyodide_packages"]]):
        shutil.copy2(dist.file(key), stage / "pyodide" / dist.packages[key]["file_name"])
    qaas = next(w for w in wheels if w.startswith("qaas-"))
    manifest = {
        **info,
        "qaas_version": wheel_name_version(qaas)[1],
        "pyodide_version": dist.version,
        "python_version": dist.python,
        "wheels": wheels,
        "sha256": {w: sha256(stage / "wheels" / w) for w in wheels},
        "built": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    (stage / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    (stage / "requirements.lock.txt").write_text(
        "".join(f"{wheel_name_version(w)[0]}=={wheel_name_version(w)[1]}\n" for w in wheels)
    )
    shutil.rmtree(OUT, ignore_errors=True)
    stage.rename(OUT)
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file()) / 1e6
    print(f"   {len(wheels)} wheels, {len(info['pyodide_packages'])} Pyodide packages, {size:.0f} MB")


def smoke_test() -> None:
    say("Smoke test")
    run(["npm", "run", "compile"], cwd=REPO)
    run(["node", HERE / "smoke-test.mjs", OUT], cwd=REPO)


# ---------------------------------------------------------------------------------- commands


def build(args: argparse.Namespace) -> None:
    ref = args.qaas or latest_qaas(args.stable)
    dist = PyodideDist(args.pyodide)
    tc = Toolchain(dist)
    work = Path(tempfile.mkdtemp(prefix="build-", dir=CACHE))
    wheelhouse = work / "wheelhouse"
    wheelhouse.mkdir()
    qaas_wheel = build_qaas(ref, dist, wheelhouse)
    closure, from_pyodide, mocks = resolve(qaas_wheel, args.extra, dist, work)
    pyodide_packages = collect(closure, from_pyodide, dist, tc, wheelhouse)
    info = {"qaas_ref": ref, "extra": args.extra, "pyodide_packages": pyodide_packages, "mock_packages": mocks}
    assemble(wheelhouse, info, dist)
    shutil.rmtree(work, ignore_errors=True)
    if not args.no_test:
        smoke_test()
    say(f"Done: {OUT}")


def assemble_cmd(args: argparse.Namespace) -> None:
    """Re-assemble wasm/ from an existing wheelhouse (e.g. an older qaas-wasm/wheels + manifest.json)."""
    wheelhouse = Path(args.wheelhouse).resolve()
    old = json.loads(Path(args.manifest).read_text()) if args.manifest else {}
    dist = PyodideDist(old.get("pyodide_version", args.pyodide))
    info = {
        "qaas_ref": old.get("qaas_ref", f"v{old.get('qaas_version', '?')}"),
        "extra": old.get("extra", DEFAULT_EXTRA),
        "pyodide_packages": old["pyodide_packages"],
        "mock_packages": old["mock_packages"],
    }
    assemble(wheelhouse, info, dist)
    if not args.no_test:
        smoke_test()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status", help="bundled vs. latest qaas and Pyodide").set_defaults(func=status)
    b = sub.add_parser("build", help="build wasm/ for a qaas release")
    b.add_argument("--qaas", help="qaas git tag (default: latest GitHub release, pre-releases included)")
    b.add_argument("--stable", action="store_true", help="with no --qaas: skip pre-releases")
    b.add_argument("--pyodide", default=DEFAULT_PYODIDE, help=f"Pyodide version (default {DEFAULT_PYODIDE})")
    b.add_argument("--extra", default=DEFAULT_EXTRA, help=f"qaas extra (default {DEFAULT_EXTRA})")
    b.add_argument("--no-test", action="store_true", help="skip the smoke test")
    b.set_defaults(func=build)
    a = sub.add_parser("assemble", help="assemble wasm/ from an existing wheelhouse")
    a.add_argument("--wheelhouse", required=True)
    a.add_argument("--manifest", help="manifest.json of that wheelhouse (pyodide/mock packages)")
    a.add_argument("--pyodide", default=DEFAULT_PYODIDE)
    a.add_argument("--no-test", action="store_true")
    a.set_defaults(func=assemble_cmd)
    sub.add_parser("test", help="smoke test of wasm/").set_defaults(func=lambda _: smoke_test())
    args = ap.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    args.func(args)


if __name__ == "__main__":
    main()
