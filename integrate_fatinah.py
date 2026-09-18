"""Apply the reviewed public-site integration to the exact inspected server."""

import hashlib
from pathlib import Path
import sys


BASE_SHA256 = "60c25c67785358cc9863c7aa1e16ea8e3c714e0d8d4310e433c30ceb7f458ec0"


def integrate(server_path):
    raw = server_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != BASE_SHA256:
        raise SystemExit("Server changed since review; compare changes before integrating.")
    source = raw.decode("utf-8")
    source = source.replace("import question_platform\n", "import question_platform\nimport public_site\n", 1)
    start = source.index("def production_landing_html() -> bytes:")
    end = source.index("# ─── Firebase config", start)
    source = (source[:start]
              + 'def production_landing_html() -> bytes:\n'
              + '    """Public game catalogue; the iOS application remains private."""\n'
              + '    return public_site.landing_html()\n\n'
              + source[end:])
    before = "        # أزيلت أكواد التفعيل الخاصة امتثالاً لسياسة مشتريات Apple."
    assert source.count(before) == 1
    source = source.replace(before, "        if public_site.serve(self, path):\n            return\n\n" + before)
    before = "                body, 'text/html; charset=utf-8', 'no-cache',\n                extra_headers={'Content-Security-Policy': WEB_CONTENT_SECURITY_POLICY})"
    after = "                body, 'text/html; charset=utf-8', 'no-cache',\n                extra_headers={'Content-Security-Policy': (WEB_CONTENT_SECURITY_POLICY\n                               if public_web_game_enabled() else public_site.CSP)})"
    assert source.count(before) == 1
    source = source.replace(before, after)
    compile(source, str(server_path), "exec")
    server_path.write_text(source, encoding="utf-8")
    print("Public-page integration applied; application routes unchanged.")


if __name__ == "__main__":
    integrate(Path(sys.argv[1] if len(sys.argv) > 1 else "server.py"))
