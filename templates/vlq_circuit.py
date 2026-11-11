"""Bell-state circuit on VLQ via qaas (QHEAppE).

Run with "QaaS: Run Current File on VLQ" or plain `python`.
LEXIS_PROJECT / LEXIS_RESOURCE / QAAS_BACKEND / LEXIS_TOKEN are read from the environment,
and PY4LEXIS_AAI_URL / PY4LEXIS_API_URL when a test LEXIS instance is configured.
Without LEXIS_TOKEN, a browser login opens. A refresh token is exchanged for an access token.
"""

import os

from qheappe_client.qprovider import QProvider
from qiskit import QuantumCircuit

qc = QuantumCircuit(2, 2)
qc.h(0)
qc.cx(0, 1)
qc.measure([0, 1], [0, 1])

token = os.environ.get("LEXIS_TOKEN") or None
if token and token.count(".") == 2:
    import base64
    import json

    claims = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))
    if claims.get("typ") in ("Refresh", "Offline"):
        from py4lexis.session import LexisSession

        token = LexisSession(login_method="token", refresh_token=token).get_access_token()

api_url = os.environ.get("PY4LEXIS_API_URL")
provider = QProvider(
    lexis_project=os.environ["LEXIS_PROJECT"],
    token=token,
    **({"lexis_api_url": api_url} if api_url else {}),
)
backend = provider.get_backend(
    lexis_resource=os.environ.get("LEXIS_RESOURCE") or None,
    backend_name=os.environ.get("QAAS_BACKEND", "VLQ"),
)

job = backend.run(backend.transpile(qc), shots=1024, job_name="vscode_bell_state")
print(f"Job submitted: {job.job_id()}")

result = job.result()
print("Counts:", result[0].data.meas.get_counts())
