#!/usr/bin/env python3
"""Fail-closed production configuration gate for Fatinah 1.3.

The gate intentionally reports check identifiers only. It never prints an
environment value, parsed credential field, exception text, or secret length.
Run it in the production deployment environment after the compatible server is
deployed and before making the v2 client available through TestFlight/App Store.
"""

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Mapping
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server  # noqa: E402  (the import is deliberately after ROOT setup)


PRODUCTION_FIREBASE_PROJECT_ID = "fatinah-game"
PRODUCTION_FIRESTORE_DATABASE_ID = "fatinah-native"
PRODUCTION_V1_GENERATION_URL = (
    "https://us-central1-fatinah-game.cloudfunctions.net/generateQuestions"
)
REQUIRED_V2_FEATURES = (
    "app_attest",
    "free_round",
    "question_history",
    "question_bank",
    "question_reports",
    "metrics",
    "ios_diagnostics",
    "revenuecat_webhook",
)
GATE_ENVIRONMENT_NAMES = {
    "FATINAH_ENVIRONMENT",
    "FATINAH_DURABLE_STORAGE",
    "FATINAH_V1_AI_GENERATION_ENABLED",
    "FATINAH_V1_APP_CHECK_ENFORCE",
    "FATINAH_V1_GENERATION_URL",
    "FATINAH_V2_APP_CHECK_ENFORCE",
    "FATINAH_V2_APP_ATTEST_ENFORCE",
    "FATINAH_V2_DEVICECHECK_ENFORCE",
    "FATINAH_APP_ATTEST_TTL_CONFIGURED",
    "FATINAH_IOS_DIAGNOSTICS_TTL_CONFIGURED",
    "FATINAH_DISTRIBUTED_RATE_LIMIT_CONFIGURED",
    "FATINAH_DISTRIBUTED_RATE_LIMIT_TTL_CONFIGURED",
    "FIREBASE_APP_CHECK_ENFORCE",
    "GOOGLE_API_KEY",
    "FIREBASE_AUTH_DOMAIN",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_STORAGE_BUCKET",
    "FIREBASE_APP_ID",
    "FIREBASE_MESSAGING_SENDER_ID",
    "FIRESTORE_DATABASE_ID",
    "FIREBASE_SERVICE_ACCOUNT_JSON",
    "APPLE_DEVICECHECK_ENVIRONMENT",
    "APPLE_DEVICECHECK_KEY_ID",
    "APPLE_DEVICECHECK_TEAM_ID",
    "APPLE_DEVICECHECK_PRIVATE_KEY",
    "APPLE_APP_ATTEST_APP_ID_PREFIX",
    "APPLE_APP_ATTEST_BUNDLE_ID",
    "REVENUECAT_IOS_API_KEY",
    "REVENUECAT_WEBHOOK_SECRET",
    "ADMIN_SECRET",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_FROM",
    "REPORT_EMAIL_TO",
    "SMTP_USERNAME",
    "SMTP_PASSWORD",
    "SMTP_USE_TLS",
    "SMTP_USE_SSL",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
} | {
    f"FATINAH_V2_FEATURE_{feature.upper()}_ENABLED"
    for feature in REQUIRED_V2_FEATURES
}
TRUE_VALUES = {"1", "true", "yes", "on", "enabled"}
FALSE_VALUES = {"0", "false", "no", "off", "disabled"}
PLACEHOLDER_VALUES = {
    "changeme",
    "change-me",
    "dummy",
    "example",
    "placeholder",
    "secret",
    "test",
}


@dataclass(frozen=True)
class GateCheck:
    code: str
    status: str


def _value(env: Mapping[str, str], name: str) -> str:
    return str(env.get(name, "") or "").strip()


def _flag(env: Mapping[str, str], name: str) -> bool | None:
    raw = _value(env, name).lower()
    if raw in TRUE_VALUES:
        return True
    if raw in FALSE_VALUES:
        return False
    return None


def _present(env: Mapping[str, str], name: str) -> bool:
    return bool(_value(env, name))


def _non_placeholder_secret(env: Mapping[str, str], name: str,
                            minimum_length: int = 32) -> bool:
    raw = _value(env, name)
    if len(raw) < minimum_length:
        return False
    lowered = raw.lower()
    return lowered not in PLACEHOLDER_VALUES and not any(
        lowered.startswith(f"{placeholder}_")
        or lowered.startswith(f"{placeholder}-")
        for placeholder in PLACEHOLDER_VALUES
    )


def _safe_production_generation_url(env: Mapping[str, str]) -> bool:
    raw = _value(env, "FATINAH_V1_GENERATION_URL")
    candidate = raw or PRODUCTION_V1_GENERATION_URL
    try:
        parsed = urlparse(candidate)
        port = parsed.port
    except ValueError:
        return False
    return bool(
        parsed.scheme == "https"
        and (parsed.hostname or "").lower()
        == "us-central1-fatinah-game.cloudfunctions.net"
        and (port is None or port == 443)
        and parsed.path == "/generateQuestions"
        and not parsed.username
        and not parsed.password
        and not parsed.query
        and not parsed.fragment
    )


def _valid_hostname(raw: str) -> bool:
    value = raw.strip().lower().rstrip(".")
    return bool(
        value
        and "://" not in value
        and re.fullmatch(
            r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
            r"[a-z]{2,63}",
            value,
        )
    )


def _valid_email(raw: str) -> bool:
    value = raw.strip()
    if len(value) > 254 or value.count("@") != 1:
        return False
    local, domain = value.rsplit("@", 1)
    return bool(local and len(local) <= 64 and _valid_hostname(domain))


def _valid_firebase_service_account(env: Mapping[str, str]) -> bool:
    raw = _value(env, "FIREBASE_SERVICE_ACCOUNT_JSON")
    if not raw:
        return False
    try:
        document = json.loads(raw)
        if not isinstance(document, dict):
            return False
        required = {
            "type",
            "project_id",
            "private_key_id",
            "private_key",
            "client_email",
            "token_uri",
        }
        if not required.issubset(document):
            return False
        if document["type"] != "service_account":
            return False
        if document["project_id"] != PRODUCTION_FIREBASE_PROJECT_ID:
            return False
        if document["project_id"] != _value(env, "FIREBASE_PROJECT_ID"):
            return False
        if document["token_uri"] != "https://oauth2.googleapis.com/token":
            return False
        if not _valid_email(str(document["client_email"])):
            return False
        if not str(document["private_key_id"]).strip():
            return False

        private_key_bytes = str(document["private_key"]).encode("utf-8")
        try:
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.asymmetric import rsa

            private_key = serialization.load_pem_private_key(
                private_key_bytes, password=None
            )
            return isinstance(private_key, rsa.RSAPrivateKey)
        except ImportError:
            # pyproject.toml installs cryptography in deployment/CI. The
            # OpenSSL fallback keeps the read-only preflight usable on a bare
            # operator Mac and captures all key material instead of printing it.
            result = subprocess.run(
                ["openssl", "rsa", "-check", "-noout"],
                input=private_key_bytes,
                capture_output=True,
                timeout=5,
                check=False,
            )
            return result.returncode == 0
    except Exception:
        return False


def _decoded_devicecheck_key(env: Mapping[str, str]) -> bytes | None:
    raw = _value(env, "APPLE_DEVICECHECK_PRIVATE_KEY")
    if not raw:
        return None
    if "BEGIN PRIVATE KEY" not in raw and "BEGIN EC PRIVATE KEY" not in raw:
        try:
            raw = base64.b64decode(raw, validate=True).decode("utf-8")
        except Exception:
            return None
    return raw.replace("\\n", "\n").encode("utf-8")


def _valid_devicecheck_private_key(env: Mapping[str, str]) -> bool:
    raw = _decoded_devicecheck_key(env)
    if raw is None:
        return False
    try:
        try:
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.asymmetric import ec

            private_key = serialization.load_pem_private_key(raw, password=None)
            return bool(
                isinstance(private_key, ec.EllipticCurvePrivateKey)
                and isinstance(private_key.curve, ec.SECP256R1)
            )
        except ImportError:
            checked = subprocess.run(
                ["openssl", "ec", "-check", "-noout"],
                input=raw,
                capture_output=True,
                timeout=5,
                check=False,
            )
            if checked.returncode != 0:
                return False
            details = subprocess.run(
                ["openssl", "ec", "-text", "-noout"],
                input=raw,
                capture_output=True,
                timeout=5,
                check=False,
            )
            description = (details.stdout + details.stderr).decode(
                "utf-8", errors="replace"
            )
            return details.returncode == 0 and (
                "ASN1 OID: prime256v1" in description
                or "NIST CURVE: P-256" in description
            )
    except Exception:
        return False


def _smtp_transport_is_secure(env: Mapping[str, str]) -> bool:
    use_ssl = _flag(env, "SMTP_USE_SSL") is True
    tls_flag = _flag(env, "SMTP_USE_TLS")
    # server.py defaults STARTTLS to true when the variable is omitted.
    use_tls = tls_flag is not False
    return use_ssl or use_tls


def _valid_smtp_port(env: Mapping[str, str]) -> bool:
    raw = _value(env, "SMTP_PORT") or "587"
    try:
        port = int(raw)
    except ValueError:
        return False
    return 1 <= port <= 65535


def _append(checks: list[GateCheck], code: str, passed: bool,
            *, warning: bool = False) -> None:
    checks.append(GateCheck(
        code=code,
        status="pass" if passed else ("warn" if warning else "fail"),
    ))


def audit_environment(env: Mapping[str, str] | None = None) -> list[GateCheck]:
    """Return value-free checks for a production release environment."""
    source = dict(os.environ if env is None else env)
    checks: list[GateCheck] = []

    managed_names = GATE_ENVIRONMENT_NAMES | set(source)
    previous = {
        name: os.environ[name]
        for name in managed_names
        if name in os.environ
    }
    try:
        # Exercise the same flag/contract helpers used by server.py without
        # performing any network request or starting the server.
        for name in managed_names:
            os.environ.pop(name, None)
        os.environ.update(source)

        _append(
            checks,
            "deployment.environment.production",
            _value(source, "FATINAH_ENVIRONMENT") == "production"
            and server.deployment_environment() == "production",
        )
        _append(
            checks,
            "deployment.durable_storage.required",
            _value(source, "FATINAH_DURABLE_STORAGE") == "required"
            and server.durable_storage_required(),
        )

        _append(
            checks,
            "v1.ai_generation.enabled",
            _flag(source, "FATINAH_V1_AI_GENERATION_ENABLED") is True
            and server.legacy_v1_generation_enabled(),
        )
        _append(
            checks,
            "v1.app_check.compatibility",
            _flag(source, "FATINAH_V1_APP_CHECK_ENFORCE") is False
            and not server.app_check_enforcement_enabled("1"),
        )
        _append(
            checks,
            "v1.generation_endpoint.production",
            _safe_production_generation_url(source),
        )

        for feature in REQUIRED_V2_FEATURES:
            _append(
                checks,
                f"v2.feature.{feature}.enabled",
                _flag(
                    source,
                    f"FATINAH_V2_FEATURE_{feature.upper()}_ENABLED",
                ) is True
                and server.v2_feature_enabled(feature),
            )

        _append(
            checks,
            "v2.app_check.enforced",
            _flag(source, "FATINAH_V2_APP_CHECK_ENFORCE") is True
            and server.app_check_enforcement_enabled("2"),
        )
        _append(
            checks,
            "v2.app_attest.enforced",
            _flag(source, "FATINAH_V2_APP_ATTEST_ENFORCE") is True
            and server.app_attest_enforcement_enabled("2"),
        )
        _append(
            checks,
            "v2.devicecheck.enforced",
            server.devicecheck_enforcement_enabled("2"),
        )

        firebase_web_names = (
            "GOOGLE_API_KEY",
            "FIREBASE_AUTH_DOMAIN",
            "FIREBASE_PROJECT_ID",
            "FIREBASE_STORAGE_BUCKET",
            "FIREBASE_APP_ID",
            "FIREBASE_MESSAGING_SENDER_ID",
        )
        _append(
            checks,
            "firebase.web_config.complete",
            all(_present(source, name) for name in firebase_web_names)
            and _valid_hostname(_value(source, "FIREBASE_AUTH_DOMAIN"))
            and _valid_hostname(_value(source, "FIREBASE_STORAGE_BUCKET"))
            and _value(source, "FIREBASE_PROJECT_ID")
            == PRODUCTION_FIREBASE_PROJECT_ID
            and _value(source, "FIREBASE_MESSAGING_SENDER_ID").isdigit(),
        )
        _append(
            checks,
            "firebase.firestore.production_database",
            _value(source, "FIRESTORE_DATABASE_ID")
            == PRODUCTION_FIRESTORE_DATABASE_ID,
        )
        _append(
            checks,
            "firebase.admin.service_account",
            _valid_firebase_service_account(source)
            and server.firestore_durable_available(),
        )

        _append(
            checks,
            "devicecheck.environment.production",
            _value(source, "APPLE_DEVICECHECK_ENVIRONMENT") == "production",
        )
        _append(
            checks,
            "devicecheck.identifiers.present",
            _present(source, "APPLE_DEVICECHECK_KEY_ID")
            and _present(source, "APPLE_DEVICECHECK_TEAM_ID"),
        )
        _append(
            checks,
            "devicecheck.private_key.p256",
            _valid_devicecheck_private_key(source),
        )
        app_id_prefix = _value(source, "APPLE_APP_ATTEST_APP_ID_PREFIX")
        _append(
            checks,
            "app_attest.app_identity",
            bool(re.fullmatch(r"[A-Z0-9]{10}", app_id_prefix))
            and app_id_prefix == _value(source, "APPLE_DEVICECHECK_TEAM_ID")
            and _value(source, "APPLE_APP_ATTEST_BUNDLE_ID")
            == "com.fatinah.game",
        )
        _append(
            checks,
            "app_attest.firestore_ttl.enabled",
            _flag(source, "FATINAH_APP_ATTEST_TTL_CONFIGURED") is True,
        )
        _append(
            checks,
            "ios_diagnostics.firestore_ttl.enabled",
            _flag(source, "FATINAH_IOS_DIAGNOSTICS_TTL_CONFIGURED") is True,
        )
        _append(
            checks,
            "operations.distributed_rate_limit.enabled",
            _flag(source, "FATINAH_DISTRIBUTED_RATE_LIMIT_CONFIGURED") is True
            and server.distributed_rate_limit_required()
            and _value(source, "FATINAH_DURABLE_STORAGE") == "required"
            and _value(source, "FIREBASE_PROJECT_ID")
            == PRODUCTION_FIREBASE_PROJECT_ID
            and _value(source, "FIRESTORE_DATABASE_ID")
            == PRODUCTION_FIRESTORE_DATABASE_ID
            and _valid_firebase_service_account(source)
            and server.firestore_durable_available(),
        )
        _append(
            checks,
            "operations.distributed_rate_limit.ttl.enabled",
            _flag(
                source,
                "FATINAH_DISTRIBUTED_RATE_LIMIT_TTL_CONFIGURED",
            ) is True
            and server.distributed_rate_limit_ttl_configured(),
        )

        revenuecat_key = _value(source, "REVENUECAT_IOS_API_KEY")
        _append(
            checks,
            "revenuecat.ios_public_key",
            revenuecat_key.startswith("appl_") and len(revenuecat_key) >= 16,
        )
        _append(
            checks,
            "revenuecat.webhook_secret",
            _non_placeholder_secret(source, "REVENUECAT_WEBHOOK_SECRET"),
        )

        _append(
            checks,
            "operations.admin_secret",
            _non_placeholder_secret(source, "ADMIN_SECRET"),
        )

        reports_enabled = server.v2_feature_enabled("question_reports")
        smtp_identity_ok = (
            _valid_hostname(_value(source, "SMTP_HOST"))
            and _valid_email(_value(source, "SMTP_FROM"))
            and _valid_email(
                _value(source, "REPORT_EMAIL_TO") or server.REPORT_EMAIL_TO
            )
        )
        smtp_credentials_ok = bool(
            _present(source, "SMTP_USERNAME")
            == _present(source, "SMTP_PASSWORD")
        )
        _append(
            checks,
            "question_reports.smtp.delivery",
            not reports_enabled
            or (
                smtp_identity_ok
                and smtp_credentials_ok
                and _smtp_transport_is_secure(source)
                and _valid_smtp_port(source)
            ),
        )

        # These providers are not used by the production server process in
        # 1.3. Keeping them there expands blast radius; warn without blocking
        # because the legacy Cloud Function is deployed separately.
        _append(
            checks,
            "least_privilege.unused_ai_secrets_absent",
            not _present(source, "OPENAI_API_KEY")
            and not _present(source, "ANTHROPIC_API_KEY"),
            warning=True,
        )
    finally:
        for name in managed_names:
            os.environ.pop(name, None)
        os.environ.update(previous)

    return checks


def release_ready(checks: list[GateCheck]) -> bool:
    return all(check.status != "fail" for check in checks)


def render_human(checks: list[GateCheck]) -> str:
    lines = [
        "Fatinah production configuration: "
        + ("READY" if release_ready(checks) else "BLOCKED"),
        "Secret values are never printed by this gate.",
    ]
    labels = {"pass": "PASS", "fail": "FAIL", "warn": "WARN"}
    lines.extend(f"[{labels[check.status]}] {check.code}" for check in checks)
    return "\n".join(lines)


def render_json(checks: list[GateCheck]) -> str:
    return json.dumps(
        {
            "ready": release_ready(checks),
            "checks": [
                {"code": check.code, "status": check.status}
                for check in checks
            ],
        },
        separators=(",", ":"),
        sort_keys=True,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate Fatinah production configuration without printing values."
    )
    parser.add_argument(
        "--json", action="store_true", help="emit a value-free JSON report"
    )
    args = parser.parse_args(argv)
    checks = audit_environment()
    print(render_json(checks) if args.json else render_human(checks))
    return 0 if release_ready(checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
