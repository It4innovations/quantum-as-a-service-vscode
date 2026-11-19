"""Browser (Pyodide / WebAssembly) adapter for ``qheappe_client``.

``qheappe_client.QClient`` is built for CPython: it runs its sync API on a
background thread with its own event loop and talks HTTP through aiohttp
sockets. Neither threads nor sockets exist in a browser. ``install()`` swaps
those two seams, without touching the qaas sources:

* the loop thread is replaced by Pyodide's single event loop; the *sync* API
  (``provider.get_backend()``, ``job.result()``, ...) blocks via
  ``pyodide.ffi.run_sync``, which needs JSPI (WebAssembly stack switching:
  Chrome/Edge 137+, Node 24+). The ``a*`` async methods work everywhere.
* HTTP goes through the browser ``fetch`` API (``pyodide.http.pyfetch``).
  The LEXIS/HEAppE endpoints must allow CORS from the page origin.
* The HEAppE events websocket is declined (browsers cannot send an
  ``Authorization`` header on WebSockets); job waiting falls back to the
  client's own job-info polling.

Usage (inside Pyodide)::

    import qaas_pyodide; qaas_pyodide.install()
    from qheappe_client import QProvider
    provider = QProvider("my_project", token=TOKEN)   # interactive login is not available
"""

from __future__ import annotations

import asyncio
import json as _json
import sys
import types
from typing import Any
from urllib.parse import urlencode

import aiohttp
from yarl import URL

__version__ = "0.1.1"
__all__ = ["FetchClientSession", "install", "is_pyodide", "sync_api_available"]

_installed = False


def is_pyodide() -> bool:
    return sys.platform == "emscripten"


def sync_api_available() -> bool:
    """True when blocking (sync) calls can run, i.e. JSPI is available."""
    try:
        from pyodide.ffi import can_run_sync
    except ImportError:
        return False
    return bool(can_run_sync())


# ---------------------------------------------------------------- HTTP via fetch


class FetchResponse:
    """Fully read response with the attributes QClient uses from aiohttp."""

    def __init__(self, url: str, status: int, reason: str, headers: dict[str, str], body: bytes):
        self.url = URL(url)
        self.status = status
        self.reason = reason
        self.headers = headers
        self._body = body
        ctype = headers.get("content-type", "")
        self.content_type = ctype.split(";")[0].strip() or "application/octet-stream"

    async def read(self) -> bytes:
        return self._body

    async def text(self, encoding: str = "utf-8") -> str:
        return self._body.decode(encoding, errors="replace")

    async def json(self, **_: Any) -> Any:
        return _json.loads(self._body)

    def raise_for_status(self) -> None:
        if self.status >= 400:
            raise aiohttp.ClientResponseError(
                None,
                (),
                status=self.status,
                message=self.reason,  # type: ignore[arg-type]
            )

    def release(self) -> None:
        pass


class _RequestContext:
    def __init__(self, coro):
        self._coro = coro
        self._resp: FetchResponse | None = None

    async def __aenter__(self) -> FetchResponse:
        self._resp = await self._coro
        return self._resp

    async def __aexit__(self, *exc) -> bool:
        return False

    def __await__(self):
        return self._coro.__await__()


class _BytesWriter:
    """Minimal stream writer for serializing aiohttp payloads into memory."""

    def __init__(self):
        self.buf = bytearray()

    async def write(self, chunk) -> None:
        self.buf.extend(chunk)

    async def write_eof(self, chunk: bytes = b"") -> None:
        self.buf.extend(chunk)

    async def drain(self) -> None:
        pass


async def _encode_body(json_body: Any, data: Any, headers: dict[str, str]) -> bytes | None:
    lower = {k.lower() for k in headers}
    if json_body is not None:
        if "content-type" not in lower:
            headers["Content-Type"] = "application/json"
        return _json.dumps(json_body).encode()
    if data is None:
        return None
    if isinstance(data, aiohttp.MultipartWriter):
        w = _BytesWriter()
        await data.write(w)
        if "content-type" not in lower:
            headers["Content-Type"] = data.content_type
        return bytes(w.buf)
    if isinstance(data, aiohttp.FormData):
        payload = data()
        w = _BytesWriter()
        await payload.write(w)
        if "content-type" not in lower:
            headers["Content-Type"] = payload.content_type
        return bytes(w.buf)
    if isinstance(data, str):
        return data.encode()
    if isinstance(data, (bytes, bytearray, memoryview)):
        return bytes(data)
    if isinstance(data, dict):
        if "content-type" not in lower:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        return urlencode(data, doseq=True).encode()
    raise TypeError(f"Unsupported request body type for fetch: {type(data).__name__}")


def _timeout_seconds(timeout: Any) -> float | None:
    if timeout is None:
        return None
    total = getattr(timeout, "total", timeout)
    return float(total) if total else None


class FetchClientSession:
    """Subset of :class:`aiohttp.ClientSession` implemented with browser ``fetch``."""

    def __init__(self, *_, timeout: Any = None, headers: dict[str, str] | None = None, **__):
        self._timeout = timeout
        self._headers = dict(headers or {})
        self.closed = False

    # aiohttp-style verbs
    def request(self, method: str, url: Any, **kw) -> _RequestContext:
        return _RequestContext(self._fetch(method, str(url), **kw))

    def get(self, url, **kw):
        return self.request("GET", url, **kw)

    def post(self, url, **kw):
        return self.request("POST", url, **kw)

    def put(self, url, **kw):
        return self.request("PUT", url, **kw)

    def patch(self, url, **kw):
        return self.request("PATCH", url, **kw)

    def delete(self, url, **kw):
        return self.request("DELETE", url, **kw)

    async def _fetch(
        self,
        method: str,
        url: str,
        *,
        params: Any = None,
        json: Any = None,
        data: Any = None,
        headers: dict[str, str] | None = None,
        timeout: Any = None,
        **_: Any,
    ) -> FetchResponse:
        if self.closed:
            raise aiohttp.ClientConnectionError("Session is closed")
        import js
        from pyodide.ffi import JsException, to_js
        from pyodide.http import pyfetch

        if params:
            items = params.items() if hasattr(params, "items") else params
            query = urlencode([(k, v) for k, v in items], doseq=True)
            url = f"{url}{'&' if '?' in url else '?'}{query}"
        hdrs = {**self._headers, **(headers or {})}
        body = await _encode_body(json, data, hdrs)
        opts: dict[str, Any] = {"method": method.upper(), "headers": hdrs}
        if body is not None:
            opts["body"] = to_js(body)
        seconds = _timeout_seconds(timeout) or _timeout_seconds(self._timeout)
        if seconds:
            opts["signal"] = js.AbortSignal.timeout(int(seconds * 1000))
        try:
            resp = await pyfetch(url, **opts)
            raw = await resp.bytes()
        except (JsException, OSError) as e:  # pyfetch wraps JS errors in AbortError(OSError)
            if "timeout" in f"{e!r} {e}".lower() or "timed out" in str(e).lower():
                raise TimeoutError(f"{method} {url} timed out after {seconds}s") from None
            raise aiohttp.ClientConnectionError(
                f"fetch failed for {url} (network error or CORS not allowed): {e}"
            ) from None
        return FetchResponse(
            resp.url or url,
            resp.status,
            resp.status_text,
            {k.lower(): v for k, v in dict(resp.headers).items()},
            raw,
        )

    async def ws_connect(self, url, **_: Any):
        raise aiohttp.ClientConnectionError(
            "WebSocket events are not available in the browser build (an Authorization "
            "header cannot be sent on a browser WebSocket); falling back to polling."
        )

    async def close(self) -> None:
        self.closed = True

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.close()


def _aiohttp_proxy() -> types.ModuleType:
    """aiohttp look-alike module: real aiohttp, with a fetch-backed session."""
    mod = types.ModuleType("aiohttp")
    mod.__dict__.update(aiohttp.__dict__)
    mod.ClientSession = FetchClientSession  # type: ignore[attr-defined]
    mod.TCPConnector = lambda *a, **k: None  # type: ignore[attr-defined]
    return mod


# ---------------------------------------------------------------- loop runner


class _Ident:
    ident = -1

    @staticmethod
    def is_alive() -> bool:
        return True

    @staticmethod
    def join(timeout: float | None = None) -> None:
        pass


class PyodideLoopRunner:
    """Drop-in for ``qclient._LoopThread`` running on Pyodide's single event loop."""

    POLL_INTERVAL = 0.2

    def __init__(self, name: str = "qclient-loop"):
        self.loop = asyncio.get_event_loop()
        self.thread = _Ident()
        self._stopped = False

    @property
    def alive(self) -> bool:
        return not self._stopped

    def run(self, coro):
        from qheappe_client.qclient import QException

        if self._stopped:
            coro.close()
            raise QException("QClient event loop is closed; the client was closed.")
        if not sync_api_available():
            coro.close()
            raise QException(
                "The synchronous qheappe_client API needs WebAssembly JSPI (Chrome/Edge 137+, "
                "Node 24+) and must be called from code run with runPythonAsync. "
                "Use the async API instead, e.g. 'await client.aget_job_info(...)'."
            )
        from pyodide.ffi import run_sync

        return run_sync(coro)

    def stop(self, timeout: float = 10.0) -> None:
        self._stopped = True


# ---------------------------------------------------------------- install


def install() -> None:
    """Patch ``qheappe_client`` for the browser. Idempotent; no-op outside Pyodide."""
    global _installed
    if _installed or not is_pyodide():
        return
    from qheappe_client import qclient

    qclient.aiohttp = _aiohttp_proxy()
    qclient._LoopThread = PyodideLoopRunner
    qclient.QClient._ssl_context = staticmethod(lambda: None)
    # QClient refuses sync calls from the loop that owns its HTTP session: on CPython blocking
    # there would deadlock. With JSPI, run_sync suspends the WebAssembly stack and the event loop
    # keeps serving the request, so sync calls from async code (e.g. a handler entered with
    # callPromising) are safe. Without JSPI, PyodideLoopRunner.run raises a clear error anyway.
    qclient.QClient._check_sync_allowed = lambda self, coro: None
    _installed = True
