"""Bell-state circuit on VLQ via qaas (QHEAppE).

Run with "QaaS: Run Current File on VLQ" or plain `python`.
LEXIS_PROJECT / LEXIS_RESOURCE / QAAS_BACKEND / LEXIS_TOKEN are read from the environment.
Without LEXIS_TOKEN, a browser login opens.
"""

import os

from qheappe_client.qprovider import QProvider
from qiskit import QuantumCircuit

qc = QuantumCircuit(2, 2)
qc.h(0)
qc.cx(0, 1)
qc.measure([0, 1], [0, 1])

provider = QProvider(
    lexis_project=os.environ["LEXIS_PROJECT"],
    token=os.environ.get("LEXIS_TOKEN") or None,
)
backend = provider.get_backend(
    lexis_resource=os.environ.get("LEXIS_RESOURCE") or None,
    backend_name=os.environ.get("QAAS_BACKEND", "VLQ"),
)

job = backend.run(backend.transpile(qc), shots=1024, job_name="vscode_bell_state")
print(f"Job submitted: {job.job_id()}")

result = job.result()
print("Counts:", result[0].data.meas.get_counts())
