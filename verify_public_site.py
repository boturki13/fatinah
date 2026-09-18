#!/usr/bin/env python3
"""Focused, offline HTTP regression checks for the ata20.com catalogue.

Usage:
    python3 Website/verify_public_site.py --server /tmp/ata20-site-work/server.py

Requires an already integrated server and the five public website files. Only
explicit source/public/legal files are copied into a TemporaryDirectory. The
real server entry point, database initialization, background workers and Firebase
are never started. Environment variables are cleared; database access and
non-loopback network connections fail the test. No .env file is read.
"""

import argparse
from contextlib import ExitStack
import gzip
from html.parser import HTMLParser
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unicodedata
import unittest
from unittest import mock


PUBLIC_FILES = (
    "index.html",
    "styles.css",
    "turn-the-path/index.html",
    "turn-the-path/support/index.html",
    "turn-the-path/privacy/index.html",
)
LEGAL_FILES = ("privacy-policy.html", "terms-of-service.html")
PRIVATE_SENTINEL = b"PRIVATE_TEST_DATA_MUST_NOT_BE_SERVED"


def normalized_arabic(value):
    return "".join(char for char in value if unicodedata.category(char) != "Mn")


class Links(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.targets = set()
        self.scripts = 0
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag in {"a", "link"} and "href" in attributes:
            self.targets.add(attributes["href"])
        if tag == "script":
            self.scripts += 1


def copy_explicit(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(source.read_bytes())


class PublicSiteTests(unittest.TestCase):
    server_source = None
    site_source = None

    @classmethod
    def setUpClass(cls):
        cls.stack = ExitStack()
        cls.addClassCleanup(cls.stack.close)
        cls.directory = Path(cls.stack.enter_context(
            tempfile.TemporaryDirectory(prefix="ata20-public-route-check-")))
        source_directory = cls.server_source.parent
        for filename in ("server.py", "question_platform.py"):
            copy_explicit(source_directory / filename, cls.directory / filename)
        copy_explicit(Path(__file__).with_name("public_site.py"),
                      cls.directory / "public_site.py")
        for filename in PUBLIC_FILES:
            copy_explicit(cls.site_source / filename,
                          cls.directory / "ata20-public" / filename)
        cls.legacy = {}
        for filename in LEGAL_FILES:
            copy_explicit(source_directory / "www" / filename,
                          cls.directory / "www" / filename)
            cls.legacy["/" + filename] = (
                cls.directory / "www" / filename).read_bytes()
        for filename in ("private-test.txt", "subscriptions.db"):
            (cls.directory / filename).write_bytes(PRIVATE_SENTINEL)
        # A visible client fixture makes a missing production block observable.
        for filename in ("index.html", "app.js", "app.css"):
            (cls.directory / "www" / filename).write_bytes(PRIVATE_SENTINEL)

        cls.stack.enter_context(mock.patch.dict(os.environ, {
            "FATINAH_ENVIRONMENT": "production",
            "FATINAH_DATABASE_PATH": str(cls.directory / "subscriptions.db"),
            "PORT": "0",
        }, clear=True))
        cls.stack.enter_context(mock.patch(
            "sqlite3.connect", side_effect=AssertionError(
                "Public-page verification must not access a database")))
        cls.stack.enter_context(mock.patch(
            "urllib.request.urlopen", side_effect=AssertionError(
                "Public-page verification must not make external HTTP requests")))
        original_connect = socket.socket.connect

        def connect_only_test_server(sock, address):
            if address != ("127.0.0.1", getattr(cls, "port", None)):
                raise AssertionError("Only the isolated test server is reachable")
            return original_connect(sock, address)

        cls.stack.enter_context(mock.patch.object(
            socket.socket, "connect", connect_only_test_server))
        cls.stack.enter_context(mock.patch.object(
            socket.socket, "connect_ex", side_effect=AssertionError(
                "Alternate network connections are disabled")))
        cls.stack.enter_context(mock.patch.object(
            socket, "getfqdn", return_value="localhost"))

        # Load only reviewed local modules; importing server does not enter main.
        for name in ("question_platform", "public_site", "_ata20_test_server"):
            filename = "server.py" if name == "_ata20_test_server" else name + ".py"
            spec = importlib.util.spec_from_file_location(name, cls.directory / filename)
            module = importlib.util.module_from_spec(spec)
            cls.stack.enter_context(mock.patch.dict(sys.modules, {name: module}))
            spec.loader.exec_module(module)
            if name == "_ata20_test_server":
                cls.module = module
        if "public_site" not in vars(cls.module):
            raise AssertionError("Supply the integrated server, not the original server")
        cls.server = cls.module.ThreadedHTTPServer(("127.0.0.1", 0), cls.module.Handler)
        cls.port = cls.server.server_port
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        # LIFO: stop/join before restoring patches or deleting the temporary tree.
        cls.stack.callback(cls.stop_server)

    @classmethod
    def stop_server(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        if cls.thread.is_alive():
            raise AssertionError("Test server did not terminate")

    def get(self, path, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request("GET", path, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def assert_public_headers(self, headers, content_type):
        self.assertEqual(headers["Content-Type"], content_type)
        self.assertIn("script-src 'none'", headers["Content-Security-Policy"])
        self.assertIn("connect-src 'none'", headers["Content-Security-Policy"])
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Cache-Control"], "no-cache")

    def test_catalogue_retains_both_games_and_legacy_links(self):
        expected = (self.site_source / "index.html").read_bytes()
        for path in ("/", "/index.html", "/?from=regression-check"):
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual(status, 200)
                self.assertEqual(body, expected)
                self.assert_public_headers(headers, "text/html; charset=utf-8")
                text = normalized_arabic(body.decode("utf-8"))
                self.assertIn("فطنة", text)
                self.assertIn("دور المسار", text)
                links = Links(body.decode("utf-8"))
                self.assertEqual(links.scripts, 0)
                for target in ("/turn-the-path/", *self.legacy):
                    self.assertIn(target, links.targets)

    def test_game_support_and_privacy_pages(self):
        for path, filename in (
            ("/turn-the-path/", "turn-the-path/index.html"),
            ("/turn-the-path/support/", "turn-the-path/support/index.html"),
            ("/turn-the-path/privacy/", "turn-the-path/privacy/index.html"),
        ):
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual(status, 200)
                self.assertEqual(body, (self.site_source / filename).read_bytes())
                self.assert_public_headers(headers, "text/html; charset=utf-8")
                links = Links(body.decode("utf-8"))
                self.assertEqual(links.scripts, 0)
                self.assertIn("/site-assets/styles.css", links.targets)
                if path != "/turn-the-path/":
                    self.assertIn("ata@ata20.com", body.decode("utf-8"))

    def test_canonical_redirects(self):
        for base in ("/turn-the-path", "/turn-the-path/support", "/turn-the-path/privacy"):
            for path in (base, base + "/index.html"):
                with self.subTest(path=path):
                    status, headers, body = self.get(path)
                    self.assertEqual(status, 308)
                    self.assertEqual(headers["Location"], base + "/")
                    self.assertEqual(headers["Content-Length"], "0")
                    self.assertEqual(body, b"")

    def test_stylesheet_and_conditional_asset_response(self):
        status, headers, body = self.get("/site-assets/styles.css")
        self.assertEqual(status, 200)
        self.assertEqual(body, (self.site_source / "styles.css").read_bytes())
        self.assert_public_headers(headers, "text/css; charset=utf-8")
        status, cached_headers, body = self.get(
            "/site-assets/styles.css", {"If-None-Match": headers["ETag"]})
        self.assertEqual(status, 304)
        self.assertEqual(cached_headers["ETag"], headers["ETag"])
        self.assertEqual(cached_headers["Content-Security-Policy"],
                         headers["Content-Security-Policy"])
        self.assertEqual(body, b"")
        status, gzip_headers, body = self.get("/", {"Accept-Encoding": "gzip"})
        self.assertEqual(status, 200)
        if gzip_headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        self.assertEqual(body, (self.site_source / "index.html").read_bytes())

    def test_existing_fatinah_legal_documents_are_unchanged(self):
        for path, expected in self.legacy.items():
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual(status, 200)
                self.assertEqual(body, expected)
                self.assertEqual(headers["Content-Security-Policy"],
                                 self.module.LEGAL_CONTENT_SECURITY_POLICY)

    def test_private_game_client_is_still_blocked_in_production(self):
        for path in ("/app.js", "/app.css", "/download/index.html"):
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual(status, 404)
                self.assertEqual(json.loads(body)["code"], "ios_app_only")
                self.assertNotIn(PRIVATE_SENTINEL, body)

    def test_unknown_paths_and_traversal_do_not_expose_files(self):
        for path in (
            "/missing", "/server.py", "/public_site.py", "/.env",
            "/subscriptions.db", "/ata20-public/index.html",
            "/turn-the-path/../../private-test.txt",
            "/turn-the-path/%2e%2e/%2e%2e/private-test.txt",
            "/site-assets/../private-test.txt",
            "/site-assets/%2e%2e%2fprivate-test.txt",
        ):
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual(status, 404)
                self.assertNotIn(PRIVATE_SENTINEL, body)

    def test_existing_version_endpoint_retains_both_api_contracts(self):
        for path, version in (("/api/version", "1"), ("/api/v2/version", "2")):
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual(status, 200)
                payload = json.loads(body)
                self.assertEqual(payload["apiVersion"], version)
                self.assertEqual(payload["environment"], "production")
                self.assertEqual(payload["applicationRelease"], self.module.APPLICATION_RELEASE)
                self.assertEqual(payload["contractRevision"], self.module.API_CONTRACT_REVISION)
                self.assertEqual(payload["supportedVersions"], ["1", "2"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", type=Path, required=True,
                        help="Path to an already integrated copy of Fatinah server.py")
    parser.add_argument("--site", type=Path, default=Path(__file__).with_name("ata20-public"),
                        help="Public page directory; default: Website/ata20-public")
    args = parser.parse_args()
    PublicSiteTests.server_source = args.server.resolve()
    PublicSiteTests.site_source = args.site.resolve()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PublicSiteTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
