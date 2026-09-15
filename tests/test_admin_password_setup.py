#!/usr/bin/env python3
"""Tests for one-time, local-only quality-dashboard password storage."""
import os
import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.request
from http.server import HTTPServer

import server as srv


class AdminPasswordSetupTests(unittest.TestCase):
    def setUp(self):
        self.original_database = srv.DB_PATH
        self.original_environment = os.environ.copy()
        handle, self.database = tempfile.mkstemp(suffix='.db')
        os.close(handle)
        srv.DB_PATH = self.database
        os.environ.pop('ADMIN_SECRET', None)
        os.environ['FATINAH_ENVIRONMENT'] = 'local'
        srv.init_db()

    def tearDown(self):
        srv.DB_PATH = self.original_database
        os.environ.clear()
        os.environ.update(self.original_environment)
        os.unlink(self.database)

    def test_password_is_hashed_and_creates_a_valid_session(self):
        password = 'Fatinah-Quality-2026!'
        srv.create_local_admin_password(password)
        self.assertTrue(srv.admin_password_configured())
        self.assertTrue(srv.verify_admin_password(password))
        self.assertFalse(srv.verify_admin_password('wrong-password'))

        with sqlite3.connect(self.database) as connection:
            salt, digest, session_secret, iterations = connection.execute(
                'SELECT password_salt,password_hash,session_secret,iterations '
                'FROM admin_credentials WHERE id=1').fetchone()
        self.assertEqual(len(salt), 32)
        self.assertEqual(len(digest), 32)
        self.assertEqual(len(session_secret), 32)
        self.assertEqual(iterations, srv.ADMIN_PASSWORD_ITERATIONS)
        with open(self.database, 'rb') as database_file:
            self.assertNotIn(password.encode(), database_file.read())

        cookie = srv.create_admin_session_cookie().split(';', 1)[0]
        self.assertTrue(srv.admin_session_valid({'Cookie': cookie}))

    def test_setup_is_single_use_and_rejects_weak_passwords(self):
        with self.assertRaises(ValueError):
            srv.create_local_admin_password('123456')
        srv.create_local_admin_password('Fatinah-Quality-2026!')
        with self.assertRaises(RuntimeError):
            srv.create_local_admin_password('Another-Quality-2026!')

    def test_loopback_detection_is_strict(self):
        self.assertTrue(srv.client_is_loopback(('127.0.0.1', 5000)))
        self.assertTrue(srv.client_is_loopback(('::1', 5000)))
        self.assertFalse(srv.client_is_loopback(('192.0.2.10', 5000)))

    def test_http_setup_then_login_flow(self):
        httpd = HTTPServer(('127.0.0.1', 0), srv.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{httpd.server_address[1]}'

        def request(path, *, payload=None, cookie=''):
            body = None if payload is None else json.dumps(payload).encode()
            headers = {'Origin': base}
            if body is not None:
                headers['Content-Type'] = 'application/json'
            if cookie:
                headers['Cookie'] = cookie
            response = urllib.request.urlopen(urllib.request.Request(
                base + path, data=body, headers=headers,
                method='POST' if body is not None else 'GET'))
            return response, json.loads(response.read())

        try:
            _, initial = request('/api/v2/admin/setup-status')
            self.assertFalse(initial['configured'])
            self.assertTrue(initial['localSetupAllowed'])

            _, created = request('/api/v2/admin/setup', payload={
                'password': 'Fatinah-Quality-2026!',
                'confirmation': 'Fatinah-Quality-2026!',
            })
            self.assertTrue(created['configured'])

            login_response, login = request('/api/v2/admin/login', payload={
                'password': 'Fatinah-Quality-2026!',
            })
            self.assertTrue(login['authenticated'])
            cookie = login_response.headers['Set-Cookie'].split(';', 1)[0]
            _, session = request('/api/v2/admin/session', cookie=cookie)
            self.assertTrue(session['authenticated'])
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
