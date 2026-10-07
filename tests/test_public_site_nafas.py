"""مسارات نَفَس العامة: ملفات محددة فقط، رؤوس أمان صحيحة، ولا وصول لغيرها."""

import json
import unittest

import public_site


class FakeHandler:
    def __init__(self):
        self.status = None
        self.headers = {}
        self.body = None
        self.asset = None

    def send_response(self, code):
        self.status = code

    def send_header(self, key, value):
        self.headers[key] = value

    def end_headers(self):
        pass

    def send_asset(self, body, content_type, cache_control, *, compress=True, extra_headers=None):
        self.status = 200
        self.body = body
        self.asset = {
            "content_type": content_type,
            "cache_control": cache_control,
            "compress": compress,
            "headers": dict(extra_headers or {}),
        }


def get(path):
    handler = FakeHandler()
    handled = public_site.serve(handler, path)
    return handled, handler


class NafasRoutesTest(unittest.TestCase):
    def test_every_route_serves_an_existing_file_with_csp(self):
        for path, (filename, content_type, _cache, _gzip) in public_site.NAFAS_ROUTES.items():
            with self.subTest(path=path):
                handled, h = get(path)
                self.assertTrue(handled)
                self.assertEqual(h.status, 200)
                self.assertTrue(h.body)
                self.assertEqual(h.asset["content_type"], content_type)
                self.assertEqual(h.asset["headers"]["Content-Security-Policy"], public_site.NAFAS_CSP)
                self.assertEqual(h.asset["headers"]["X-Frame-Options"], "DENY")
                self.assertTrue((public_site.ROOT / filename).resolve().is_relative_to(public_site.ROOT / "nafas"))

    def test_csp_blocks_inline_scripts_and_framing(self):
        csp = public_site.NAFAS_CSP
        self.assertIn("script-src 'self';", csp)
        self.assertNotIn("unsafe-inline", csp)
        self.assertNotIn("unsafe-eval", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertIn("object-src 'none'", csp)

    def test_redirects_to_canonical_folder(self):
        for path in ("/nafas", "/nafas/index.html"):
            with self.subTest(path=path):
                handled, h = get(path)
                self.assertTrue(handled)
                self.assertEqual(h.status, 308)
                self.assertEqual(h.headers["Location"], "/nafas/")

    def test_unknown_and_traversal_paths_are_not_served(self):
        for path in ("/nafas/../server.py", "/nafas/README.md", "/nafas/icons/",
                     "/nafas/app.js.map", "/nafas/%2e%2e/server.py", "/nafas/CNAME"):
            with self.subTest(path=path):
                handled, h = get(path)
                self.assertFalse(handled)
                self.assertIsNone(h.body)

    def test_pngs_are_not_gzipped_and_text_is_no_cache(self):
        for path, (_f, content_type, cache, gzip_on) in public_site.NAFAS_ROUTES.items():
            with self.subTest(path=path):
                if content_type == "image/png":
                    self.assertFalse(gzip_on)
                else:
                    self.assertEqual(cache, "no-cache")

    def test_manifest_and_service_worker_stay_inside_nafas_scope(self):
        manifest = json.loads((public_site.ROOT / "nafas/manifest.webmanifest").read_text("utf-8"))
        self.assertEqual(manifest["start_url"], "./")
        self.assertEqual(manifest["scope"], "./")
        for icon in manifest["icons"]:
            self.assertIn("/nafas/" + icon["src"], public_site.NAFAS_ROUTES)
        sw = (public_site.ROOT / "nafas/sw.js").read_text("utf-8")
        # يجب ألا يحذف عامل الخدمة كاش تطبيقات أخرى على نفس الدومين
        self.assertIn('k.startsWith("nafas-")', sw)

    def test_html_references_only_routed_files(self):
        html = (public_site.ROOT / "nafas/index.html").read_text("utf-8")
        for ref in ("styles.css", "app.js", "manifest.webmanifest", "icons/icon-192.png", "icons/apple-touch-icon.png"):
            with self.subTest(ref=ref):
                self.assertIn(f'"{ref}"', html)
                self.assertIn("/nafas/" + ref, public_site.NAFAS_ROUTES)

    def test_existing_public_routes_unchanged(self):
        handled, h = get("/turn-the-path/")
        self.assertTrue(handled)
        self.assertEqual(h.asset["headers"]["Content-Security-Policy"], public_site.CSP)


if __name__ == "__main__":
    unittest.main()
