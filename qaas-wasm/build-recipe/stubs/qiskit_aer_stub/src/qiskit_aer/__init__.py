"""Import-only stub of qiskit-aer for Pyodide (WebAssembly).

The real qiskit-aer is a C++/OpenMP simulator that is not built for WASM.
This stub only lets modules that import it at load time (e.g. iqm.qiskit_iqm
fake backends) be imported. Any actual use raises NotImplementedError.
"""

__version__ = "0.17.2+wasmstub"
WASM_STUB = True


class _Unavailable:
    _what = "qiskit_aer"

    def __init__(self, *args, **kwargs):
        raise NotImplementedError(
            f"{self._what} is not available in the Pyodide/WASM build "
            "(qiskit-aer stub). Use qiskit.primitives / quantum_info or run remotely."
        )

    @classmethod
    def from_backend(cls, *a, **k):
        cls()


class AerSimulator(_Unavailable):
    _what = "qiskit_aer.AerSimulator"


class AerProvider(_Unavailable):
    _what = "qiskit_aer.AerProvider"


Aer = None
