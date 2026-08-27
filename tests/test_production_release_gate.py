#!/usr/bin/env python3
"""Focused tests for the value-free production configuration gate."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "production_release_gate.py"
SPEC = importlib.util.spec_from_file_location("production_release_gate", MODULE_PATH)
assert SPEC and SPEC.loader
gate = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = gate
SPEC.loader.exec_module(gate)


def generated_private_pem(algorithm: str) -> str:
    command = ["openssl", "genpkey", "-algorithm", algorithm]
    if algorithm == "RSA":
        command.extend(["-pkeyopt", "rsa_keygen_bits:2048"])
    else:
        command.extend(["-pkeyopt", "ec_paramgen_curve:P-256"])
    result = subprocess.run(
        command, capture_output=True, timeout=10, check=True
    )
    return result.stdout.decode("utf-8")


def valid_environment() -> dict[str, str]:
    firebase_key = generated_private_pem("RSA")
    devicecheck_key = generated_private_pem("EC")
    firebase_document = {
        "type": "service_account",
        "project_id": "fatinah-game",
        "private_key_id": "KEY_ID_SENTINEL",
        "private_key": firebase_key,
        "client_email": "server@fatinah-game.iam.gserviceaccount.com",
        "token_uri": "https://oauth2.googleapis.com/token",
    }
    result = {
        "FATINAH_ENVIRONMENT": "production",
        "FATINAH_DURABLE_STORAGE": "required",
        "FATINAH_V1_AI_GENERATION_ENABLED": "true",
        "FATINAH_V1_APP_CHECK_ENFORCE": "false",
        "FATINAH_V1_GENERATION_URL": (
            "https://us-central1-fatinah-game.cloudfunctions.net/"
            "generateQuestions"
        ),
        "FATINAH_V2_APP_CHECK_ENFORCE": "true",
        "FATINAH_V2_APP_ATTEST_ENFORCE": "true",
        "FATINAH_V2_DEVICECHECK_ENFORCE": "true",
        "FATINAH_APP_ATTEST_TTL_CONFIGURED": "true",
        "FATINAH_IOS_DIAGNOSTICS_TTL_CONFIGURED": "true",
        "FATINAH_DISTRIBUTED_RATE_LIMIT_CONFIGURED": "true",
        "FATINAH_DISTRIBUTED_RATE_LIMIT_TTL_CONFIGURED": "true",
        "GOOGLE_API_KEY": "GOOGLE_API_KEY_SENTINEL",
        "FIREBASE_AUTH_DOMAIN": "fatinah-game.firebaseapp.com",
        "FIREBASE_PROJECT_ID": "fatinah-game",
        "FIREBASE_STORAGE_BUCKET": "fatinah-game.firebasestorage.app",
        "FIREBASE_APP_ID": "FIREBASE_APP_ID_SENTINEL",
        "FIREBASE_MESSAGING_SENDER_ID": "508338410340",
        "FIRESTORE_DATABASE_ID": "fatinah-native",
        "FIREBASE_SERVICE_ACCOUNT_JSON": json.dumps(firebase_document),
        "APPLE_DEVICECHECK_ENVIRONMENT": "production",
        "APPLE_DEVICECHECK_KEY_ID": "DEVICECHECK_KEY_ID_SENTINEL",
        "APPLE_DEVICECHECK_TEAM_ID": "A1B2C3D4E5",
        "APPLE_DEVICECHECK_PRIVATE_KEY": devicecheck_key,
        "APPLE_APP_ATTEST_APP_ID_PREFIX": "A1B2C3D4E5",
        "APPLE_APP_ATTEST_BUNDLE_ID": "com.fatinah.game",
        "REVENUECAT_IOS_API_KEY": "appl_PUBLIC_KEY_SENTINEL_123456",
        "REVENUECAT_WEBHOOK_SECRET": "RC_WEBHOOK_SENTINEL_0123456789abcdef0123456789",
        "ADMIN_SECRET": "ADMIN_SENTINEL_0123456789abcdef0123456789",
        "SMTP_HOST": "smtp.example.com",
        "SMTP_PORT": "587",
        "SMTP_FROM": "reports@example.com",
        "REPORT_EMAIL_TO": "ata@ata20.com",
        "SMTP_USERNAME": "reports@example.com",
        "SMTP_PASSWORD": "SMTP_PASSWORD_SENTINEL",
        "SMTP_USE_TLS": "true",
        "SMTP_USE_SSL": "false",
    }
    for feature in gate.REQUIRED_V2_FEATURES:
        result[f"FATINAH_V2_FEATURE_{feature.upper()}_ENABLED"] = "true"
    return result


def statuses(checks) -> dict[str, str]:
    return {check.code: check.status for check in checks}


environment = valid_environment()
checks = gate.audit_environment(environment)
assert gate.release_ready(checks), gate.render_human(checks)
assert all(check.status == "pass" for check in checks)


# The reviewed remote question bank is required by the 1.3 round endpoint.
# Production defaults features to disabled, so both omission and an explicit
# false value must prevent a misleading READY result.
for disabled_value in (None, "false"):
    question_bank_disabled = dict(environment)
    if disabled_value is None:
        question_bank_disabled.pop(
            "FATINAH_V2_FEATURE_QUESTION_BANK_ENABLED", None
        )
    else:
        question_bank_disabled[
            "FATINAH_V2_FEATURE_QUESTION_BANK_ENABLED"
        ] = disabled_value
    question_bank_checks = gate.audit_environment(question_bank_disabled)
    assert statuses(question_bank_checks)[
        "v2.feature.question_bank.enabled"
    ] == "fail"
    assert not gate.release_ready(question_bank_checks)


# The report contains identifiers and statuses only, never environment values.
human_report = gate.render_human(checks)
json_report = gate.render_json(checks)
for secret_value in (
    environment["FIREBASE_SERVICE_ACCOUNT_JSON"],
    environment["APPLE_DEVICECHECK_PRIVATE_KEY"],
    environment["REVENUECAT_WEBHOOK_SECRET"],
    environment["ADMIN_SECRET"],
    environment["SMTP_PASSWORD"],
    environment["FIREBASE_PROJECT_ID"],
    environment["REPORT_EMAIL_TO"],
):
    assert secret_value not in human_report
    assert secret_value not in json_report

cli_environment = dict(os.environ)
cli_environment.update(environment)
cli_result = subprocess.run(
    [sys.executable, str(MODULE_PATH), "--json"],
    cwd=ROOT,
    env=cli_environment,
    capture_output=True,
    text=True,
    timeout=15,
    check=False,
)
assert cli_result.returncode == 0, cli_result.stdout
assert json.loads(cli_result.stdout)["ready"] is True
for secret_value in (
    environment["FIREBASE_SERVICE_ACCOUNT_JSON"],
    environment["APPLE_DEVICECHECK_PRIVATE_KEY"],
    environment["REVENUECAT_WEBHOOK_SECRET"],
    environment["SMTP_PASSWORD"],
):
    assert secret_value not in cli_result.stdout
    assert secret_value not in cli_result.stderr


# A typo in the environment, an unsafe v1 URL, or a disabled v2 control blocks.
broken = dict(environment)
broken.update({
    "FATINAH_ENVIRONMENT": "prodution",
    "FATINAH_V1_GENERATION_URL": "https://example.com/generateQuestions",
    "FATINAH_V2_APP_CHECK_ENFORCE": "false",
    "FATINAH_V2_APP_ATTEST_ENFORCE": "false",
    "FATINAH_V2_FEATURE_FREE_ROUND_ENABLED": "false",
    "FATINAH_APP_ATTEST_TTL_CONFIGURED": "false",
    "FATINAH_IOS_DIAGNOSTICS_TTL_CONFIGURED": "false",
    "FATINAH_DISTRIBUTED_RATE_LIMIT_CONFIGURED": "false",
    "FATINAH_DISTRIBUTED_RATE_LIMIT_TTL_CONFIGURED": "false",
})
broken_statuses = statuses(gate.audit_environment(broken))
assert broken_statuses["deployment.environment.production"] == "fail"
assert broken_statuses["v1.generation_endpoint.production"] == "fail"
assert broken_statuses["v2.app_check.enforced"] == "fail"
assert broken_statuses["v2.app_attest.enforced"] == "fail"
assert broken_statuses["v2.feature.free_round.enabled"] == "fail"
assert broken_statuses["app_attest.firestore_ttl.enabled"] == "fail"
assert broken_statuses["ios_diagnostics.firestore_ttl.enabled"] == "fail"
assert broken_statuses["operations.distributed_rate_limit.enabled"] == "fail"
assert broken_statuses[
    "operations.distributed_rate_limit.ttl.enabled"
] == "fail"

limiter_without_ttl = dict(environment)
limiter_without_ttl[
    "FATINAH_DISTRIBUTED_RATE_LIMIT_TTL_CONFIGURED"
] = "false"
limiter_statuses = statuses(gate.audit_environment(limiter_without_ttl))
assert limiter_statuses["operations.distributed_rate_limit.enabled"] == "pass"
assert limiter_statuses[
    "operations.distributed_rate_limit.ttl.enabled"
] == "fail"
assert not gate.release_ready(gate.audit_environment(limiter_without_ttl))


# The limiter flag is not a self-attestation: production must also have the
# reviewed Firestore database and usable Admin credentials for atomic CAS.
limiter_without_firestore = dict(environment)
limiter_without_firestore["FIREBASE_SERVICE_ACCOUNT_JSON"] = "{}"
limiter_statuses = statuses(gate.audit_environment(limiter_without_firestore))
assert limiter_statuses["operations.distributed_rate_limit.enabled"] == "fail"
assert not gate.release_ready(gate.audit_environment(limiter_without_firestore))

limiter_with_wrong_database = dict(environment)
limiter_with_wrong_database["FIRESTORE_DATABASE_ID"] = "default"
limiter_statuses = statuses(gate.audit_environment(limiter_with_wrong_database))
assert limiter_statuses["operations.distributed_rate_limit.enabled"] == "fail"


# v1 App Check must remain explicitly disabled while App Store version 1.2 lives.
incompatible = dict(environment)
incompatible["FATINAH_V1_APP_CHECK_ENFORCE"] = "true"
incompatible_statuses = statuses(gate.audit_environment(incompatible))
assert incompatible_statuses["v1.app_check.compatibility"] == "fail"


# Production storage identity and both credential types must be real key shapes.
bad_credentials = dict(environment)
bad_credentials["FIRESTORE_DATABASE_ID"] = "default"
bad_credentials["FIREBASE_SERVICE_ACCOUNT_JSON"] = "{}"
bad_credentials["APPLE_DEVICECHECK_PRIVATE_KEY"] = "not-a-private-key"
credential_statuses = statuses(gate.audit_environment(bad_credentials))
assert credential_statuses["firebase.firestore.production_database"] == "fail"
assert credential_statuses["firebase.admin.service_account"] == "fail"
assert credential_statuses["devicecheck.private_key.p256"] == "fail"


# Question reports may not be released with plaintext SMTP or half credentials.
bad_smtp = dict(environment)
bad_smtp.update({
    "SMTP_USE_TLS": "false",
    "SMTP_USE_SSL": "false",
    "SMTP_PASSWORD": "",
})
smtp_statuses = statuses(gate.audit_environment(bad_smtp))
assert smtp_statuses["question_reports.smtp.delivery"] == "fail"


# Extra AI credentials in the server are least-privilege warnings, not a reason
# to break the legacy Cloud Function deployment workflow.
warning_environment = dict(environment)
warning_environment["OPENAI_API_KEY"] = "OPENAI_SECRET_SENTINEL"
warning_checks = gate.audit_environment(warning_environment)
warning_statuses = statuses(warning_checks)
assert warning_statuses["least_privilege.unused_ai_secrets_absent"] == "warn"
assert gate.release_ready(warning_checks)


print("production release configuration gate tests passed")
