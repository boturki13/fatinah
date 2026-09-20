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
REDIRECTS = {
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
