"""Lazy Firebase Admin bridge for local token verification.

Imports stay lazy so static assets and public endpoints do not pay Firebase's
startup cost. The service-account JSON is read only from the server environment.
"""
import json
import os
import threading

_lock = threading.Lock()
_app = None


def _firebase_app():
    global _app
    if _app is not None:
        return _app
    with _lock:
        if _app is not None:
            return _app
        import firebase_admin
        from firebase_admin import credentials

        raw = os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON', '').strip()
        project_id = os.environ.get('FIREBASE_PROJECT_ID', '').strip()
        if not raw or not project_id:
            raise RuntimeError('Firebase Admin credentials are not configured')
        credential = credentials.Certificate(json.loads(raw))
        try:
            _app = firebase_admin.get_app('fatinah-server')
        except ValueError:
            _app = firebase_admin.initialize_app(
                credential,
                {'projectId': project_id},
                name='fatinah-server',
            )
        return _app


def verify_id_token(token: str):
    from firebase_admin import auth
    return auth.verify_id_token(token, app=_firebase_app(), check_revoked=False)


def verify_app_check_token(token: str):
    from firebase_admin import app_check
    return app_check.verify_token(token, app=_firebase_app())
