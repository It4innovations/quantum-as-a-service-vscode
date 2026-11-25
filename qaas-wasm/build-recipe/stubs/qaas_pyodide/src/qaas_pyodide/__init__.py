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
import re
import sys
import types
from typing import Any
from urllib.parse import urlencode

import aiohttp
from yarl import URL

__version__ = "0.1.5"
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


RETRIES = 2
# Connection dropped or refused before the response was complete (Node/undici and browser wording).
_RETRYABLE = re.compile(r"terminated|other side closed|ECONNRESET|socket hang up|UND_ERR_SOCKET|network error", re.I)


def _js_error_text(e: BaseException) -> str:
    """Message of a JS error and its cause (undici puts the socket error in ``cause``)."""
    parts = []
    err: Any = e
    for _ in range(4):
        name, message = getattr(err, "name", None), getattr(err, "message", None)
        if message is None:
            parts.append(str(err))
            break
        parts.append(f"{name}: {message}" if name else str(message))
        err = getattr(err, "cause", None)
        if err is None:
            break
        code = getattr(err, "code", None)
        if code:
            parts.append(str(code))
    return " / ".join(dict.fromkeys(p for p in parts if p))


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
        from pyodide.ffi import to_js

        if params:
            items = params.items() if hasattr(params, "items") else params
            query = urlencode([(k, v) for k, v in items], doseq=True)
            url = f"{url}{'&' if '?' in url else '?'}{query}"
        hdrs = {**self._headers, **(headers or {})}
        body = await _encode_body(json, data, hdrs)
        seconds = _timeout_seconds(timeout) or _timeout_seconds(self._timeout)
        # Requests that can be repeated are retried when the connection drops, e.g. a kept-alive
        # connection the server closed while the response was read (Node: "TypeError: terminated").
        attempts = RETRIES + 1 if method.upper() in ("GET", "HEAD", "OPTIONS") else 1
        for attempt in range(attempts):
            init: dict[str, Any] = {"method": method.upper(), "headers": hdrs}
            if body is not None:
                init["body"] = to_js(body)
            signal = js.AbortSignal.timeout(int(seconds * 1000)) if seconds else None
            if signal is not None:
                init["signal"] = signal
            try:
                # js.fetch, not pyodide.http.pyfetch: pyfetch turns some failures into
                # "'NoneType' object has no attribute 'message'" and loses the cause.
                resp = await js.fetch(url, to_js(init, dict_converter=js.Object.fromEntries))
                raw = (await resp.arrayBuffer()).to_bytes()
                headers_out = js.Object.fromEntries(resp.headers.entries()).to_py()
                break
            except Exception as e:
                if signal is not None and signal.aborted:
                    raise TimeoutError(f"{method} {url} timed out after {seconds}s") from None
                reason = _js_error_text(e)
                if attempt + 1 < attempts and _RETRYABLE.search(reason):
                    await asyncio.sleep(0.5 * (attempt + 1))
                    continue
                raise aiohttp.ClientConnectionError(f"{method} {url} failed: {reason}") from None
        return FetchResponse(
            resp.url or url,
            resp.status,
            resp.statusText,
            {str(k).lower(): str(v) for k, v in headers_out.items()},
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
    _inline_thread_pools()  # before qheappe_client imports py4heappe and qiskit its primitives
    from qheappe_client import qclient

    qclient.aiohttp = _aiohttp_proxy()
    qclient._LoopThread = PyodideLoopRunner
    qclient.QClient._ssl_context = staticmethod(lambda: None)
    # QClient refuses sync calls from the loop that owns its HTTP session: on CPython blocking
    # there would deadlock. With JSPI, run_sync suspends the WebAssembly stack and the event loop
    # keeps serving the request, so sync calls from async code (e.g. a handler entered with
    # callPromising) are safe. Without JSPI, PyodideLoopRunner.run raises a clear error anyway.
    qclient.QClient._check_sync_allowed = lambda self, coro: None
    _no_browser_in_workers()
    _installed = True


class InlineThreadPool:
    """``multiprocessing.pool.ThreadPool`` stand-in that runs each task at once, in the caller.

    py4heappe's ApiClient creates a ThreadPool in ``__init__`` and only uses it for
    ``async_req=True`` calls. Pyodide has no threads and no ``_multiprocessing``, so the real pool
    cannot even be created."""

    def __init__(self, *_, **__):
        pass

    def apply_async(self, func, args=(), kwds=None, callback=None, error_callback=None):
        return _Done(func, args, kwds or {}, callback, error_callback)

    def apply(self, func, args=(), kwds=None):
        return func(*args, **(kwds or {}))

    def map(self, func, iterable, chunksize=None):
        return [func(x) for x in iterable]

    def close(self) -> None:
        pass

    def terminate(self) -> None:
        pass

    def join(self) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Done:
    """AsyncResult of a task that already ran."""

    def __init__(self, func, args, kwds, callback, error_callback):
        self._error = None
        try:
            self._value = func(*args, **kwds)
        except Exception as exc:
            self._value, self._error = None, exc
            if error_callback:
                error_callback(exc)
        else:
            if callback:
                callback(self._value)

    def get(self, timeout=None):
        if self._error is not None:
            raise self._error
        return self._value

    def wait(self, timeout=None) -> None:
        pass

    def ready(self) -> bool:
        return True

    def successful(self) -> bool:
        return self._error is None


def _inline_thread_pools() -> None:
    """Thread pools that run tasks inline: ``multiprocessing.pool.ThreadPool`` (py4heappe) and
    ``concurrent.futures.ThreadPoolExecutor`` (qiskit primitives), for later imports and in modules
    that already imported them."""
    import concurrent.futures
    import concurrent.futures.thread
    import multiprocessing.pool

    original = concurrent.futures.thread.ThreadPoolExecutor
    multiprocessing.pool.ThreadPool = InlineThreadPool  # type: ignore[misc,assignment]
    concurrent.futures.ThreadPoolExecutor = InlineExecutor  # type: ignore[misc,assignment]
    concurrent.futures.thread.ThreadPoolExecutor = InlineExecutor  # type: ignore[misc,assignment]
    for name, module in list(sys.modules.items()):
        if name.startswith("py4heappe.") and name.endswith(".api_client") and hasattr(module, "ThreadPool"):
            module.ThreadPool = InlineThreadPool
        if getattr(module, "ThreadPoolExecutor", None) is original:
            module.ThreadPoolExecutor = InlineExecutor


class InlineExecutor:
    """``concurrent.futures.ThreadPoolExecutor`` stand-in: each task runs at once, in the caller,
    and its future is already done. Qiskit's primitives (StatevectorSampler, ...) submit every job
    to a ThreadPoolExecutor; Pyodide cannot start threads."""

    def __init__(self, *_, **__):
        pass

    def submit(self, fn, /, *args, **kwargs):
        import concurrent.futures

        future: concurrent.futures.Future = concurrent.futures.Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as exc:
            future.set_exception(exc)
        return future

    def map(self, fn, *iterables, timeout=None, chunksize=1):
        return iter([fn(*args) for args in zip(*iterables, strict=False)])

    def shutdown(self, wait=True, *, cancel_futures=False) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _no_browser_in_workers() -> None:
    """Pyodide's webbrowser.open uses window.open, which a worker (e.g. VS Code's) does not have.
    Report "no browser" instead, as CPython does without one: py4lexis then only prints the login
    URL, which the host shows to the user."""
    import webbrowser

    import js

    if not hasattr(js, "window"):
        webbrowser.open = lambda url, new=0, autoraise=True: False  # type: ignore[assignment]
        webbrowser.open_new = webbrowser.open_new_tab = lambda url: False  # type: ignore[assignment]
