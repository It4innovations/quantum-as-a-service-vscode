import importlib
import os
import time
import traceback

import micropip

t = time.time()
MOCKS = [("py4lexis", "7.1.0"), ("symengine", "0.14.1"), ("qiskit-aer", "0.17.2"),
         ("grpcio", "1.76.0"), ("scipy-stubs", "1.16.0.0"), ("psutil", "7.2.2")]
for n, v in MOCKS:
    micropip.add_mock_package(n, v)
import pyodide_js

await pyodide_js.loadPackage(["ssl", "bcrypt", "cffi", "cryptography", "markupsafe", "numpy", "pandas",
                              "pydantic-core", "pynacl", "pyyaml", "rustworkx", "scipy"])
wheels = sorted("emfs:/wheels/" + w for w in os.listdir("/wheels"))
await micropip.install(wheels, deps=False)
print("installed %d wheels in %.1fs" % (len(wheels), time.time() - t))
for m in ["qaas", "qaas.client", "qheappe_client", "qheappe_client.qpulla",
          "iqm.qiskit_iqm", "py4heappe"]:
    try:
        importlib.import_module(m); print("OK  ", m)
    except BaseException as e:
        print("FAIL", m, type(e).__name__, e); traceback.print_exc(limit=-3)
print("total %.1fs" % (time.time() - t))
