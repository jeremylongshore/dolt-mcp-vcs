"""Regression suite for the fail-closed creds-ref resolver (creds-ref MAJOR).

Run:  python3 -m unittest tests.test_resolve_creds_ref -v
Only env: is exercised end-to-end (sops/pass need external tooling); the unknown-
scheme and fail-closed-on-non-loopback paths are the security-critical ones.
"""
import importlib.util
import os
import subprocess
import sys
import unittest

_SCRIPTS = os.path.join(os.path.dirname(__file__), os.pardir, "scripts")
_PATH = os.path.join(_SCRIPTS, "resolve-creds-ref.py")
_spec = importlib.util.spec_from_file_location("resolve_creds_ref", _PATH)
rcr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rcr)


class TestPureLogic(unittest.TestCase):
    def test_loopback_detection(self):
        for ep in ["127.0.0.1:3308", "localhost:3306", "::1", "[::1]:3306", "localhost", ""]:
            self.assertTrue(rcr.is_loopback(ep), ep)
        for ep in ["10.0.0.5:3306", "db.example.com:3306", "doltremoteapi.dolthub.com"]:
            self.assertFalse(rcr.is_loopback(ep), ep)

    def test_scheme_parse(self):
        self.assertEqual(rcr.parse_scheme("env:DOLT_PASSWORD"), ("env", "DOLT_PASSWORD"))
        self.assertEqual(rcr.parse_scheme("sops:secrets.sops.yaml#dolt"),
                         ("sops", "secrets.sops.yaml#dolt"))
        self.assertEqual(rcr.parse_scheme("nocolon"), (None, None))

    def test_unknown_scheme_rejected(self):
        secret, ok = rcr.resolve("file:/etc/passwd")
        self.assertFalse(ok)
        secret, ok = rcr.resolve("literal-secret-no-scheme")
        self.assertFalse(ok)

    def test_env_resolution(self):
        os.environ["_TEST_CREDS_VAL"] = "hunter2"
        secret, ok = rcr.resolve("env:_TEST_CREDS_VAL")
        self.assertTrue(ok)
        self.assertEqual(secret, "hunter2")
        del os.environ["_TEST_CREDS_VAL"]


def _run(creds_ref, endpoint, env=None):
    e = dict(os.environ)
    if env:
        e.update(env)
    return subprocess.run(
        [sys.executable, _PATH, "--creds-ref", creds_ref, "--endpoint", endpoint],
        capture_output=True, text=True, env=e)


class TestCliFailClosed(unittest.TestCase):
    def test_unknown_scheme_exits_2(self):
        r = _run("file:/etc/passwd", "127.0.0.1:3308")
        self.assertEqual(r.returncode, 2)

    def test_empty_loopback_ok(self):
        # env var unset -> empty -> loopback permits it (exit 0, empty stdout).
        r = _run("env:_DEFINITELY_UNSET_VAR_XYZ", "127.0.0.1:3308")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout, "")

    def test_empty_non_loopback_fails_closed(self):
        r = _run("env:_DEFINITELY_UNSET_VAR_XYZ", "db.example.com:3306")
        self.assertEqual(r.returncode, 4)
        self.assertIn("fail-closed", r.stderr)

    def test_resolved_secret_on_stdout(self):
        r = _run("env:_CREDS_OK", "db.example.com:3306", env={"_CREDS_OK": "s3cret"})
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout, "s3cret")


if __name__ == "__main__":
    unittest.main()
