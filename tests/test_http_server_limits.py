#!/usr/bin/env python3
"""Regression tests for slow-request and unbounded-thread protections."""

from __future__ import annotations

import socket
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server as srv


# محلياً يبقى الحد لكل عميل مباشراً، لكن نسخة Replit لا تُخنق لأن عدة لاعبين
# قد يصلون من TCP peer واحد تابع للبروكسي المُدار.
assert srv.HTTP_MAX_CONNECTIONS_PER_IP == 4
deployment_env = dict(os.environ)
deployment_env['REPLIT_DEPLOYMENT'] = '1'
deployment_env.pop('FATINAH_HTTP_MAX_CONNECTIONS_PER_IP', None)
deployment_limit = subprocess.check_output(
    [sys.executable, '-c',
     'import server; print(server.HTTP_MAX_CONNECTIONS_PER_IP)'],
    cwd=ROOT,
    env=deployment_env,
    text=True,
).strip()
assert deployment_limit == str(srv.HTTP_MAX_WORKER_THREADS)


class TinyHardenedServer(srv.ThreadedHTTPServer):
    request_timeout_seconds = 0.2
    max_worker_threads = 2
    max_connections_per_ip = 1


httpd = TinyHardenedServer(('127.0.0.1', 0), srv.Handler)
port = httpd.server_address[1]
thread = threading.Thread(target=httpd.serve_forever, daemon=True)
thread.start()


def connect() -> socket.socket:
    connection = socket.create_connection(('127.0.0.1', port), timeout=1)
    connection.settimeout(1)
    return connection


def assert_closed(connection: socket.socket) -> None:
    try:
        assert connection.recv(1) == b''
    except (ConnectionResetError, BrokenPipeError):
        pass


try:
    slow = connect()
    slow.sendall(
        b'POST /api/questions/seen HTTP/1.1\r\n'
        b'Host: localhost\r\n'
        b'Content-Length: 1\r\n'
    )
    stop_drip = threading.Event()

    def drip_bytes():
        while not stop_drip.wait(0.05):
            try:
                slow.sendall(b'X')
            except OSError:
                return

    drip_thread = threading.Thread(target=drip_bytes, daemon=True)
    drip_thread.start()
    deadline = time.monotonic() + 1
    while httpd._worker_slots._value != 1 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert httpd._worker_slots._value == 1

    # One client IP cannot occupy the second worker slot.
    excess = connect()
    excess.sendall(b'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')
    assert_closed(excess)
    excess.close()

    # Sending a byte before every idle timeout still cannot extend the absolute
    # request deadline.
    time.sleep(0.3)
    stop_drip.set()
    drip_thread.join(timeout=1)
    assert_closed(slow)
    slow.close()

    # Once the timed-out request is released, legitimate traffic is served.
    healthy = connect()
    healthy.sendall(b'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
    response = b''
    while True:
        chunk = healthy.recv(4096)
        if not chunk:
            break
        response += chunk
    healthy.close()
    assert response.startswith(b'HTTP/1.0 200') or response.startswith(b'HTTP/1.1 200')
finally:
    httpd.shutdown()
    httpd.server_close()
    thread.join(timeout=2)

print('HTTP server limits test: PASS')
