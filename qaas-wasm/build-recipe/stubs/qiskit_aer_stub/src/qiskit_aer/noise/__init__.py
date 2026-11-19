from .errors import QuantumError, ReadoutError, depolarizing_error, thermal_relaxation_error  # noqa: F401 (API)


class NoiseModel:
    """Records errors so code that only *builds* noise models keeps working."""

    def __init__(self, basis_gates=None, *a, **k):
        self.basis_gates = list(basis_gates or [])
        self.quantum_errors = []
        self.readout_errors = []

    def add_quantum_error(self, error, instructions, qubits, *a, **k):
        self.quantum_errors.append((error, instructions, tuple(qubits)))

    def add_all_qubit_quantum_error(self, error, instructions, *a, **k):
        self.quantum_errors.append((error, instructions, None))

    def add_readout_error(self, error, qubits, *a, **k):
        self.readout_errors.append((error, tuple(qubits)))

    def add_basis_gates(self, gates):
        self.basis_gates.extend(g for g in gates if g not in self.basis_gates)
