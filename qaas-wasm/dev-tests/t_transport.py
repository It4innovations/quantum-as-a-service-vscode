import json
import os

import micropip

for n, v in [("py4lexis", "7.1.0"), ("symengine", "0.14.1"), ("grpcio", "1.76.0"),
             ("scipy-stubs", "1.16.0.0"), ("psutil", "7.2.2")]:
    micropip.add_mock_package(n, v)
import pyodide_js

await pyodide_js.loadPackage(["ssl", "bcrypt", "cffi", "cryptography", "markupsafe", "numpy", "pandas",
                              "pydantic-core", "pynacl", "pyyaml", "rustworkx", "scipy"])
await micropip.install(sorted("emfs:/wheels/" + w for w in os.listdir("/wheels")), deps=False)

import qaas_pyodide

qaas_pyodide.install()
import aiohttp
from qheappe_client.qclient import QClient, QException

B = "http://127.0.0.1:8765"
c = QClient("tok", "proj", load_machine_info=False)
c._session = qaas_pyodide.FetchClientSession()
print("sync API available (JSPI):", qaas_pyodide.sync_api_available())
ok = 0

# 1. sync API path (JSPI run_sync) with query params
r = c._run(c._request("GET", B + "/echo", params={"a": 1, "b": ["x", "y"]}))
d = json.loads(r.body); assert d["query"] == [["a", "1"], ["b", "x"], ["b", "y"]], d
assert d["auth"] and d["auth"].startswith("Bearer"), d["auth"]; ok += 1
print("1 sync GET+params OK  status", r.status, r.content_type, "auth:", d["auth"][:12])

# 2. async API path, JSON body
r = await c._request("POST", B + "/echo", json_body={"k": [1, 2]})
d = json.loads(r.body); assert d["content_type"] == "application/json" and json.loads(d["body"]) == {"k": [1, 2]}; ok += 1
print("2 async POST json OK")

# 3. multipart (same construction as QClient job submission)
with aiohttp.MultipartWriter("form-data") as mp:
    p = mp.append(json.dumps({"x": 1}), {"Content-Type": "application/json"})
    p.set_content_disposition("form-data", name="model")
    f = mp.append(b"OPENQASM 3.0;", {"Content-Type": "application/octet-stream"})
    f.set_content_disposition("form-data", name="file", filename="c.qasm")
r = await c._request("POST", B + "/echo", data=mp)
d = json.loads(r.body)
assert d["content_type"].startswith("multipart/form-data; boundary=") and 'filename="c.qasm"' in d["body"] and "OPENQASM 3.0;" in d["body"], d; ok += 1
print("3 multipart upload OK", len(d["body"]), "bytes")

# 4. HTTP error -> QException
try:
    await c._request("GET", B + "/err"); raise AssertionError("no error")
except QException as e:
    assert "HTTP 500" in str(e); ok += 1; print("4 HTTP 500 ->", e)

# 5. timeout -> QException
try:
    await c._request("GET", B + "/slow", timeout=0.5); raise AssertionError("no timeout")
except QException as e:
    assert "Timeout" in str(e); ok += 1; print("5 timeout ->", e)

# 6. connection refused -> QException
try:
    await c._request("GET", "http://127.0.0.1:9/x", timeout=5); raise AssertionError("no error")
except QException as e:
    ok += 1; print("6 unreachable ->", str(e)[:110])

# 7. websocket declined -> polling fallback signal
try:
    await c._session.ws_connect("wss://example/heappe/Events")
except aiohttp.ClientError as e:
    ok += 1; print("7 ws declined ->", str(e)[:70])

# 8. qiskit + QBackend-free path: transpile & QASM3 export used by job submission
from qiskit import QuantumCircuit, transpile
from qiskit.qasm3 import dumps

qc = QuantumCircuit(2); qc.h(0); qc.cx(0, 1); qc.measure_all()
t = transpile(qc, basis_gates=["r", "cz"], optimization_level=2)
assert "OPENQASM 3.0" in dumps(t); ok += 1; print("8 qiskit transpile+qasm3 OK", dict(t.count_ops()))
c.close()
print(f"TRANSPORT CHECKS PASSED: {ok}/8")
