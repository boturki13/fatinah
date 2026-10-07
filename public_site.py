"""Public game pages: explicit routes only, with no access to application data."""

from pathlib import Path


ROOT = Path(__file__).resolve().parent / "ata20-public"
CSP = (
    "default-src 'none'; script-src 'none'; style-src 'self'; "
    "img-src 'self' data:; font-src 'self'; connect-src 'none'; "
    "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)
ROUTES = {
    "/app-ads.txt": ("app-ads.txt", "text/plain; charset=utf-8"),
    "/site-assets/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/turn-the-path/": ("turn-the-path/index.html", "text/html; charset=utf-8"),
    "/turn-the-path/support/": ("turn-the-path/support/index.html", "text/html; charset=utf-8"),
    "/turn-the-path/privacy/": ("turn-the-path/privacy/index.html", "text/html; charset=utf-8"),
}
# نَفَس: تطبيق ويب ثابت (PWA) يعمل بالكامل داخل متصفح المستخدم، بلا API ولا
# بيانات خادم. له سياسة CSP خاصة لأنه يحتاج سكربته وعامل الخدمة والخطوط.
NAFAS_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; "
    "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; "
    "manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; "
    "form-action 'none'; frame-ancestors 'none'"
)
NAFAS_HEADERS = {
    "Content-Security-Policy": NAFAS_CSP,
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-Frame-Options": "DENY",
}
# path -> (file, content type, cache-control, gzip)
NAFAS_ROUTES = {
    "/nafas/": ("nafas/index.html", "text/html; charset=utf-8", "no-cache", True),
    "/nafas/styles.css": ("nafas/styles.css", "text/css; charset=utf-8", "no-cache", True),
    "/nafas/app.js": ("nafas/app.js", "application/javascript; charset=utf-8", "no-cache", True),
    "/nafas/sw.js": ("nafas/sw.js", "application/javascript; charset=utf-8", "no-cache", True),
    "/nafas/manifest.webmanifest": ("nafas/manifest.webmanifest", "application/manifest+json; charset=utf-8", "no-cache", True),
    "/nafas/icons/icon-192.png": ("nafas/icons/icon-192.png", "image/png", "public, max-age=86400", False),
    "/nafas/icons/icon-512.png": ("nafas/icons/icon-512.png", "image/png", "public, max-age=86400", False),
    "/nafas/icons/maskable-512.png": ("nafas/icons/maskable-512.png", "image/png", "public, max-age=86400", False),
    "/nafas/icons/apple-touch-icon.png": ("nafas/icons/apple-touch-icon.png", "image/png", "public, max-age=86400", False),
}
REDIRECTS = {
    "/nafas": "/nafas/",
    "/nafas/index.html": "/nafas/",
    "/turn-the-path": "/turn-the-path/",
    "/turn-the-path/index.html": "/turn-the-path/",
    "/turn-the-path/support": "/turn-the-path/support/",
    "/turn-the-path/support/index.html": "/turn-the-path/support/",
    "/turn-the-path/privacy": "/turn-the-path/privacy/",
    "/turn-the-path/privacy/index.html": "/turn-the-path/privacy/",
}


def landing_html():
    return (ROOT / "index.html").read_bytes()


def serve(handler, path):
    """Return whether a public route was handled; never accept arbitrary paths."""
    if path in REDIRECTS:
        handler.send_response(308)
        handler.send_header("Location", REDIRECTS[path])
        handler.send_header("Content-Length", "0")
        handler.send_header("Cache-Control", "no-cache")
        handler.end_headers()
        return True
    if path in NAFAS_ROUTES:
        filename, content_type, cache_control, compress = NAFAS_ROUTES[path]
        try:
            body = (ROOT / filename).read_bytes()
        except OSError:
            handler.send_response(404)
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return True
        handler.send_asset(
            body, content_type, cache_control,
            compress=compress, extra_headers=dict(NAFAS_HEADERS),
        )
        return True
    if path not in ROUTES:
        return False
    filename, content_type = ROUTES[path]
    try:
        body = (ROOT / filename).read_bytes()
    except OSError:
        handler.send_response(404)
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return True
    handler.send_asset(
        body, content_type, "no-cache",
        extra_headers={"Content-Security-Policy": CSP, "Referrer-Policy": "no-referrer"},
    )
    return True
