"""Every bridge method the extension calls must exist on Server."""

import os
import re
import stat
import sys
import tempfile
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


def _jwt(claims: dict) -> str:
    import base64
    import json

    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"eyJhbGciOiJub25lIn0.{body}.sig"


class AccessTokenTests(unittest.TestCase):
    def test_access_token_is_returned_as_is_with_expiry(self):
        token = _jwt({"typ": "Bearer", "exp": 1_900_000_000})
        out = qaas_bridge.Server().accessToken({"token": token})
        self.assertEqual(out["token"], token)
        self.assertTrue(out["expiresAt"].startswith("2030-03-17"))

    def test_refresh_token_is_exchanged_never_returned(self):
        refresh = _jwt({"typ": "Offline"})
        access = _jwt({"typ": "Bearer"})
        server = qaas_bridge.Server()
        server._sessions[(refresh, None, None, None)] = type("S", (), {"get_access_token": lambda self: access})()
        out = server.accessToken({"token": refresh})
        self.assertEqual(out["token"], access)
        self.assertNotIn(refresh, str(out))


class _Session:
    def __init__(self, fail: bool = False):
        self.fail, self.calls = fail, 0

    def logout(self):
        self.calls += 1
        if self.fail:
            raise RuntimeError("offline")


class LogoutTests(unittest.TestCase):
    def setUp(self):
        self.created: list[tuple] = []
        self._orig = qaas_bridge._new_session

        def fake(token, aai, api, realm):
            self.created.append((token, aai, api, realm))
            return _Session()

        qaas_bridge._new_session = fake

    def tearDown(self):
        qaas_bridge._new_session = self._orig

    def test_revokes_live_sessions_and_stored_refresh_tokens_and_clears_state(self):
        server = qaas_bridge.Server()
        browser, live = _Session(), _Session()
        live_token = _jwt({"typ": "Refresh", "n": 1})
        server._sessions[(None, None, None, None)] = browser  # browser login
        server._sessions[(live_token, None, None, None)] = live
        server._providers[("p", "access", None)] = object()
        stored = _jwt({"typ": "Offline", "n": 2})
        out = server.logout(
            {
                "tokens": [
                    {"token": live_token},  # already revoked through its session
                    {"token": stored, "instance": {"aaiUrl": "https://aai.test.example.org/", "realm": "T"}},
                    {"token": _jwt({"typ": "Bearer"})},  # access token: cannot be revoked
                ]
            }
        )
        self.assertEqual(out, {"revoked": 3, "skipped": 1, "failed": []})
        self.assertEqual((browser.calls, live.calls), (1, 1))
        self.assertEqual(self.created, [(stored, "https://aai.test.example.org", None, "T")])
        self.assertEqual((server._sessions, server._providers, server._issued), ({}, {}, {}))

    def test_failures_are_reported_and_state_is_still_cleared(self):
        server = qaas_bridge.Server()
        server._sessions[(None, "https://aai.test.example.org", None, None)] = _Session(fail=True)
        out = server.logout({})
        self.assertEqual(out["revoked"], 0)
        self.assertEqual(len(out["failed"]), 1)
        self.assertIn("aai.test.example.org", out["failed"][0])
        self.assertEqual(server._sessions, {})


@unittest.skipIf(os.name == "nt", "POSIX permissions")
class PrivateLogTests(unittest.TestCase):
    def test_log_is_created_user_only_and_existing_log_is_tightened(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "sub" / "lexis.log"
            qaas_bridge._private_log(log)
            self.assertEqual(stat.S_IMODE(log.stat().st_mode), 0o600)
            log.chmod(0o644)
            qaas_bridge._private_log(log)
            self.assertEqual(stat.S_IMODE(log.stat().st_mode), 0o600)

    def test_planted_symlink_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            victim = Path(d) / "victim"
            victim.write_text("keep")
            link = Path(d) / "lexis.log"
            link.symlink_to(victim)
            with self.assertRaises(OSError):
                qaas_bridge._private_log(link)
            self.assertEqual(victim.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
