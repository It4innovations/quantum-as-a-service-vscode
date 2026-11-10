# Quantum-as-a-Service for VS Code

Run Qiskit circuits on the **VLQ** quantum computer from VS Code, through
[LEXIS](https://docs.lexis.tech/) and [HEAppE](https://heappe.eu/), using the
[`qaas`](https://github.com/It4innovations/quantum-as-a-service) Python package (QHEAppE client).

## Features

| Command | What it does |
| --- | --- |
| `QaaS: Check Python Environment` | Shows the interpreter and the installed `qaas`, `qiskit`, `iqm-client`, `py4lexis` versions. |
| `QaaS: Install qaas Package` | Runs `pip install qaas[<extra>]` from the IT4I package index in a terminal. |
| `QaaS: Set LEXIS Token` / `Clear LEXIS Token` | Stores a LEXIS access token in VS Code secret storage. Without one, a browser login opens. |
| `QaaS: List Available Backends` | Lists the backends for your LEXIS project and sets the default one. |
| `QaaS: New VLQ Circuit File` | Opens a Bell-state example that runs on VLQ. |
| `QaaS: Run Current File on VLQ` | Runs the open Python file with your LEXIS settings in the environment (also in the editor's Run menu). |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `qaas.pythonPath` | *(empty)* | Interpreter with `qaas`. Empty uses the Python extension's selection, then `python3`. |
| `qaas.lexisProject` | *(empty)* | LEXIS project identifier. |
| `qaas.lexisResource` | *(empty)* | LEXIS resource name; empty lets the client choose. |
| `qaas.backendName` | `VLQ` | Backend name. |
| `qaas.packageExtra` | `iqm_qiskit` | IQM extra to install (see the qaas compatibility table). |
| `qaas.packageIndexUrl` | IT4I GitLab index | Extra pip index that hosts `qaas`. |

Scripts started with **Run Current File on VLQ** receive `LEXIS_PROJECT`, `LEXIS_RESOURCE`,
`QAAS_BACKEND` and, if set, `LEXIS_TOKEN` as environment variables.

## Requirements

- Python 3.12 with `qaas` and one IQM extra installed
- A LEXIS project with access to a quantum resource

## How it works

The extension does not reimplement the client. It runs
[`python/qaas_bridge.py`](python/qaas_bridge.py) with your interpreter; the script calls
`qheappe_client.qprovider.QProvider` and prints one JSON line back to the extension.

## Development

```bash
npm install
npm run compile     # or: npm run watch
npm test            # downloads VS Code and runs the extension tests
npm run package     # builds a .vsix
```

Press <kbd>F5</kbd> in VS Code to start an Extension Development Host.

## License

Apache-2.0
