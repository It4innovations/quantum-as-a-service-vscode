"""Inert noise-channel placeholders: they can be built and combined, never simulated."""


class QuantumError:
    def __init__(self, *args, **kwargs):
        self._args = args

    def compose(self, other, *a, **k):
        return QuantumError(self, other)

    def tensor(self, other, *a, **k):
        return QuantumError(self, other)

    def expand(self, other, *a, **k):
        return QuantumError(self, other)

    __matmul__ = compose


class ReadoutError:
    def __init__(self, probabilities, *a, **k):
        self.probabilities = probabilities


def depolarizing_error(param, num_qubits, *a, **k):
    return QuantumError("depolarizing", param, num_qubits)


def thermal_relaxation_error(t1, t2, time, *a, **k):
    return QuantumError("thermal_relaxation", t1, t2, time)
