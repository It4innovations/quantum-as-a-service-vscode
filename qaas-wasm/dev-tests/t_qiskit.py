import time

import micropip

t=time.time()
await micropip.install("emfs:/wheels/qiskit-2.1.2-cp39-abi3-pyodide_2025_0_wasm32.whl")
import qiskit
from qiskit import QuantumCircuit, transpile
from qiskit.qasm3 import dumps
from qiskit.quantum_info import Statevector
from qiskit.transpiler import CouplingMap

qc = QuantumCircuit(3); qc.h(0); qc.cx(0,1); qc.cx(1,2); qc.measure_all()
print("qiskit", qiskit.__version__)
print(Statevector(qc.remove_final_measurements(inplace=False)).probabilities_dict())
tq = transpile(qc, basis_gates=["r","cz"], coupling_map=CouplingMap.from_line(5), optimization_level=3, seed_transpiler=1)
print("transpiled ops", dict(tq.count_ops()), "depth", tq.depth())
print(dumps(tq)[:120].replace("\n"," | "))
print("elapsed %.1fs"%(time.time()-t))
