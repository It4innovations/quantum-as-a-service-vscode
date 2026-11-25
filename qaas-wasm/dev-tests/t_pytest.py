import os
import time

import micropip

MOCKS = [("py4lexis", "7.1.0"), ("symengine", "0.14.1"), ("grpcio", "1.76.0"),
         ("scipy-stubs", "1.16.0.0"), ("psutil", "7.2.2")]
for n, v in MOCKS:
    micropip.add_mock_package(n, v)
import pyodide_js

await pyodide_js.loadPackage(["ssl", "bcrypt", "cffi", "cryptography", "markupsafe", "numpy", "pandas",
                              "pydantic-core", "pynacl", "pyyaml", "rustworkx", "scipy", "pytest"])
await micropip.install(sorted("emfs:/wheels/" + w for w in os.listdir("/wheels")), deps=False)
if os.environ.get("ADAPTER", "0") == "1" or "ADAPTER" in globals():
    import qaas_pyodide; qaas_pyodide.install(); print("adapter installed")
import pytest

os.chdir("/repo")
args = ["tests/qheappe", "-m", "not integration", "-q", "-p", "no:cacheprovider", "-o", "addopts=",
        "-c", "/dev/null", "--rootdir", "/repo", "-x" if False else "-rfE", "--tb=line"]
args += [a for a in os.environ.get("PYTEST_EXTRA", "").split() if a]
t = time.time()
rc = pytest.main(args)
print("pytest rc", rc, "in %.0fs" % (time.time() - t))
