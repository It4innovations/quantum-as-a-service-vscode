"""LEXIS instance and token handling of the bridge, with py4lexis and qaas replaced by fakes."""

import base64
import json
import sys
import types
import unittest
from pathlib import Path
from typing import ClassVar

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import qaas_bridge


def jwt(**claims) -> str:
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")  # noqa: E731
    return f"{enc({'alg': 'HS256'})}.{enc(claims)}.sig"


class FakeSession:
    instances: ClassVar[list] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.n = 0
        FakeSession.instances.append(self)

    def get_access_token(self):
        return jwt(typ="Bearer", n=self.n, preferred_username="tester", iss="https://aai.staging.example.org/realms/x")


class FakeProvider:
    def __init__(self, lexis_project, token=None, **kwargs):
        self.project, self.token, self.kwargs = lexis_project, token, kwargs


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        FakeSession.instances = []
        self._saved = {k: sys.modules.get(k) for k in ("py4lexis", "py4lexis.session", "qheappe_client.qprovider")}
        session_mod = types.ModuleType("py4lexis.session")
        session_mod.LexisSession = FakeSession
        provider_mod = types.ModuleType("qheappe_client.qprovider")
        provider_mod.QProvider = FakeProvider
        sys.modules.update(
            {
                "py4lexis": types.ModuleType("py4lexis"),
                "py4lexis.session": session_mod,
                "qheappe_client.qprovider": provider_mod,
            }
        )
        self.test_instance = {
            "aaiUrl": "https://aai.staging.example.org/",
            "apiUrl": "https://api.staging.example.org/",
        }

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    def test_token_kind(self):
        self.assertEqual(qaas_bridge.token_kind(None), "login")
        self.assertEqual(qaas_bridge.token_kind(jwt(typ="Refresh")), "refresh")
        self.assertEqual(qaas_bridge.token_kind(jwt(typ="Offline")), "refresh")
        self.assertEqual(qaas_bridge.token_kind(jwt(typ="Bearer")), "access")
        self.assertEqual(qaas_bridge.token_kind("opaque-token"), "access")

    def test_access_token_is_passed_through_with_test_api_url(self):
        server = qaas_bridge.Server()
        access = jwt(typ="Bearer")
        provider = server._provider({"project": "p", "token": access, "instance": self.test_instance})
        self.assertEqual(provider.token, access)
        self.assertEqual(provider.kwargs, {"lexis_api_url": "https://api.staging.example.org"})
        self.assertEqual(FakeSession.instances, [])

    def test_production_does_not_pass_api_url(self):
        provider = qaas_bridge.Server()._provider({"project": "p", "token": jwt(typ="Bearer")})
        self.assertEqual(provider.kwargs, {})

    def test_refresh_token_uses_session_on_instance_and_renews_clients(self):
        server = qaas_bridge.Server()
        refresh = jwt(typ="Refresh")
        p = {"project": "p", "token": refresh, "instance": {**self.test_instance, "realm": "LEXIS"}}
        first = server._provider(p)
        (session,) = FakeSession.instances
        self.assertEqual(session.kwargs["login_method"], "token")
        self.assertEqual(session.kwargs["refresh_token"], refresh)
        self.assertEqual(session.kwargs["aai_url"], "https://aai.staging.example.org")
        self.assertEqual(session.kwargs["api_url"], "https://api.staging.example.org")
        self.assertEqual(session.kwargs["realm"], "LEXIS")
        self.assertTrue(session.kwargs["reraise_exceptions"])
        self.assertIs(server._provider(p), first)

        session.n = 1  # py4lexis renewed the access token
        second = server._provider(p)
        self.assertIsNot(second, first)
        self.assertNotEqual(second.token, first.token)
        self.assertEqual(len(server._providers), 1)
        self.assertEqual(len(FakeSession.instances), 1)

    def test_browser_login_session_targets_instance(self):
        server = qaas_bridge.Server()
        me = server.whoami({"project": "p", "instance": self.test_instance})
        (session,) = FakeSession.instances
        self.assertNotIn("login_method", session.kwargs)
        self.assertEqual(session.kwargs["aai_url"], "https://aai.staging.example.org")
        self.assertEqual(me["user"], "tester")
        self.assertEqual(me["tokenKind"], "login")
        self.assertEqual(me["apiUrl"], "https://api.staging.example.org")

    def test_missing_project(self):
        with self.assertRaises(qaas_bridge.BridgeError):
            qaas_bridge.Server()._provider({"token": jwt(typ="Bearer")})


if __name__ == "__main__":
    unittest.main()
