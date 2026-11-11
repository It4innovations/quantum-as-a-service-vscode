"""Every bridge method the extension calls must exist on Server."""

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

import qaas_bridge  # noqa: E402

CALL_RE = re.compile(r"\b(?:request|call)(?:<[^>]*>)?\(\s*(?:[^,()]*\?\s*)?\"(\w+)\"(?:\s*:\s*\"(\w+)\")?")


class BridgeContractTests(unittest.TestCase):
    def test_methods_called_from_typescript_exist(self):
        called = set()
        for ts in (ROOT / "src").rglob("*.ts"):
            for m in CALL_RE.finditer(ts.read_text()):
                called.update(x for x in m.groups() if x)
        self.assertGreater(len(called), 10, called)
        missing = sorted(name for name in called if not callable(getattr(qaas_bridge.Server, name, None)))
        self.assertEqual(missing, [], f"called from TypeScript but not defined on Server: {missing}")


if __name__ == "__main__":
    unittest.main()
