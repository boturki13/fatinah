"""Strict, offline verifier for Apple App Attest artifacts.

This module deliberately contains no HTTP, database, challenge-store, or user
authentication code.  Callers must issue unpredictable one-time challenges and
atomically consume them together with the stored key/counter update.

The implementation follows Apple's server-side validation algorithm and pins
the Apple App Attestation Root CA published at:
https://www.apple.com/certificateauthority/private/
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from typing import Literal

import cbor2
from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature,
    encode_dss_signature,
)
from cryptography.x509.oid import ExtensionOID, ObjectIdentifier


APPLE_APP_ATTESTATION_ROOT_CA_PEM = b"""-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----
"""

_NONCE_EXTENSION_OID = ObjectIdentifier("1.2.840.113635.100.8.2")
_PRODUCTION_AAGUID = b"appattest" + (b"\x00" * 7)
_DEVELOPMENT_AAGUID = b"appattestdevelop"
_SANDBOX_AAGUID = b"appattestsandbox"
_P256_ORDER = int(
    "FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16
)
_MAX_CBOR_BYTES = 2 * 1024 * 1024
_MAX_CBOR_DEPTH = 16
_MAX_CBOR_ITEMS = 256


class AppAttestVerificationError(ValueError):
    """A fail-closed App Attest verification error with a log-safe code."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class AppAttestReplayError(AppAttestVerificationError):
    """The assertion counter did not advance and the request may be a replay."""

    def __init__(self) -> None:
        super().__init__("assertion_counter_replay")


@dataclass(frozen=True, slots=True)
class AttestationVerificationResult:
    public_key_pem: bytes
    receipt: bytes
    counter: int
    bundle_version: str | None
    validation_category: int | None


@dataclass(frozen=True, slots=True)
class AssertionVerificationResult:
    counter: int


@dataclass(frozen=True, slots=True)
class _AttestedAuthenticatorData:
    rp_id_hash: bytes
    flags: int
    counter: int
    aaguid: bytes
    credential_id: bytes
    credential_public_key_x: bytes
    credential_public_key_y: bytes
    bundle_version: str | None
    validation_category: bytes | None


def _fail(code: str) -> AppAttestVerificationError:
    return AppAttestVerificationError(code)


def _read_cbor_argument(data: bytes, offset: int, additional: int) -> tuple[int, int]:
    if additional < 24:
        return additional, offset
    widths = {24: 1, 25: 2, 26: 4, 27: 8}
    width = widths.get(additional)
    if width is None:  # Includes indefinite-length items (31).
        raise _fail("cbor_noncanonical")
    end = offset + width
    if end > len(data):
        raise _fail("cbor_truncated")
    value = int.from_bytes(data[offset:end], "big")
    minimum = {1: 24, 2: 256, 4: 65_536, 8: 4_294_967_296}[width]
    if value < minimum:
        raise _fail("cbor_noncanonical")
    return value, end


def _scan_cbor_item(
    data: bytes,
    offset: int,
    *,
    depth: int,
    budget: list[int],
) -> tuple[int, tuple[int, object] | None]:
    if depth > _MAX_CBOR_DEPTH:
        raise _fail("cbor_too_deep")
    budget[0] -= 1
    if budget[0] < 0:
        raise _fail("cbor_too_many_items")
    if offset >= len(data):
        raise _fail("cbor_truncated")

    initial = data[offset]
    offset += 1
    major = initial >> 5
    additional = initial & 0x1F
    argument, offset = _read_cbor_argument(data, offset, additional)

    if major == 0:
        return offset, (major, argument)
    if major == 1:
        return offset, (major, -1 - argument)
    if major in {2, 3}:
        end = offset + argument
        if end > len(data):
            raise _fail("cbor_truncated")
        payload = data[offset:end]
        if major == 3:
            try:
                decoded: object = payload.decode("utf-8", "strict")
            except UnicodeDecodeError as exc:
                raise _fail("cbor_invalid_utf8") from exc
        else:
            decoded = payload
        return end, (major, decoded)
    if major == 4:
        for _ in range(argument):
            offset, _ = _scan_cbor_item(
                data, offset, depth=depth + 1, budget=budget
            )
        return offset, None
    if major == 5:
        seen_keys: set[tuple[int, object]] = set()
        for _ in range(argument):
            offset, key = _scan_cbor_item(
                data, offset, depth=depth + 1, budget=budget
            )
            # App Attest uses only integer/text keys (and byte keys are safe to
            # recognize). Reject compound/tagged keys to make duplicate-key
            # detection deterministic before cbor2 constructs a dict.
            if key is None or key[0] not in {0, 1, 2, 3}:
                raise _fail("cbor_unsupported_map_key")
            if key in seen_keys:
                raise _fail("cbor_duplicate_key")
            seen_keys.add(key)
            offset, _ = _scan_cbor_item(
                data, offset, depth=depth + 1, budget=budget
            )
        return offset, None

    # Tags, floats, simple values, break markers, and indefinite containers
    # aren't part of Apple's App Attest structures and are rejected.
    raise _fail("cbor_unsupported_type")


def _decode_cbor_prefix_strict(data: bytes) -> tuple[object, int]:
    if not isinstance(data, bytes) or not data or len(data) > _MAX_CBOR_BYTES:
        raise _fail("cbor_invalid_size")
    end, _ = _scan_cbor_item(data, 0, depth=0, budget=[_MAX_CBOR_ITEMS])
    try:
        stream = BytesIO(data[:end])
        decoded = cbor2.CBORDecoder(stream).decode()
    except (cbor2.CBORDecodeError, UnicodeDecodeError, ValueError) as exc:
        raise _fail("cbor_decode_failed") from exc
    if stream.read(1):
        raise _fail("cbor_trailing_data")
    return decoded, end


def _decode_cbor_strict(data: bytes) -> object:
    decoded, end = _decode_cbor_prefix_strict(data)
    if end != len(data):
        raise _fail("cbor_trailing_data")
    return decoded


def _decode_key_id(key_id: str) -> bytes:
    if not isinstance(key_id, str) or not key_id or len(key_id) > 128:
        raise _fail("invalid_key_id")
    try:
        raw = base64.b64decode(key_id.encode("ascii"), validate=True)
    except (UnicodeEncodeError, binascii.Error) as exc:
        raise _fail("invalid_key_id") from exc
    if len(raw) != 32 or base64.b64encode(raw).decode("ascii") != key_id:
        raise _fail("invalid_key_id")
    return raw


def _app_id(team_id: str, bundle_id: str) -> bytes:
    if not isinstance(team_id, str) or not isinstance(bundle_id, str):
        raise _fail("invalid_app_id")
    if not team_id or not bundle_id or len(team_id) > 64 or len(bundle_id) > 255:
        raise _fail("invalid_app_id")
    try:
        return f"{team_id}.{bundle_id}".encode("ascii", "strict")
    except UnicodeEncodeError as exc:
        raise _fail("invalid_app_id") from exc


def _verify_certificate_signature(
    certificate: x509.Certificate,
    issuer: x509.Certificate,
) -> None:
    if certificate.issuer != issuer.subject:
        raise _fail("certificate_issuer_mismatch")
    issuer_key = issuer.public_key()
    if not isinstance(issuer_key, ec.EllipticCurvePublicKey):
        raise _fail("unsupported_certificate_key")
    hash_algorithm = certificate.signature_hash_algorithm
    if hash_algorithm is None or hash_algorithm.name.lower() in {"sha1", "md5"}:
        raise _fail("weak_certificate_signature")
    try:
        issuer_key.verify(
            certificate.signature,
            certificate.tbs_certificate_bytes,
            ec.ECDSA(hash_algorithm),
        )
    except InvalidSignature as exc:
        raise _fail("invalid_certificate_signature") from exc


def _certificate_valid_at(certificate: x509.Certificate, now: datetime) -> None:
    if not (certificate.not_valid_before_utc <= now <= certificate.not_valid_after_utc):
        raise _fail("certificate_expired_or_not_yet_valid")


def _require_basic_constraints(certificate: x509.Certificate, *, ca: bool) -> None:
    try:
        constraints = certificate.extensions.get_extension_for_class(
            x509.BasicConstraints
        ).value
    except x509.ExtensionNotFound as exc:
        raise _fail("missing_basic_constraints") from exc
    if constraints.ca is not ca:
        raise _fail("invalid_basic_constraints")


def _require_key_usage(certificate: x509.Certificate, *, ca: bool) -> None:
    try:
        usage = certificate.extensions.get_extension_for_class(x509.KeyUsage).value
    except x509.ExtensionNotFound as exc:
        raise _fail("missing_key_usage") from exc
    if ca:
        if not usage.key_cert_sign:
            raise _fail("invalid_ca_key_usage")
    elif not usage.digital_signature:
        raise _fail("invalid_leaf_key_usage")


def _reject_unknown_critical_extensions(certificate: x509.Certificate) -> None:
    known = {
        ExtensionOID.BASIC_CONSTRAINTS,
        ExtensionOID.KEY_USAGE,
        ExtensionOID.EXTENDED_KEY_USAGE,
        ExtensionOID.AUTHORITY_KEY_IDENTIFIER,
        ExtensionOID.SUBJECT_KEY_IDENTIFIER,
        ExtensionOID.CERTIFICATE_POLICIES,
        ExtensionOID.CRL_DISTRIBUTION_POINTS,
        ExtensionOID.AUTHORITY_INFORMATION_ACCESS,
        _NONCE_EXTENSION_OID,
    }
    for extension in certificate.extensions:
        if extension.critical and extension.oid not in known:
            raise _fail("unknown_critical_certificate_extension")


def _validate_aki_ski(certificate: x509.Certificate, issuer: x509.Certificate) -> None:
    try:
        authority = certificate.extensions.get_extension_for_class(
            x509.AuthorityKeyIdentifier
        ).value.key_identifier
        subject = issuer.extensions.get_extension_for_class(
            x509.SubjectKeyIdentifier
        ).value.digest
    except x509.ExtensionNotFound:
        return
    if authority is not None and not hmac.compare_digest(authority, subject):
        raise _fail("certificate_key_identifier_mismatch")


def _validate_certificate_chain(
    x5c: object,
    *,
    now: datetime | None = None,
) -> x509.Certificate:
    if (
        not isinstance(x5c, list)
        or len(x5c) != 2
        or any(not isinstance(item, bytes) or not item or len(item) > 16_384 for item in x5c)
    ):
        raise _fail("invalid_x5c")
    try:
        leaf = x509.load_der_x509_certificate(x5c[0])
        intermediate = x509.load_der_x509_certificate(x5c[1])
        root = x509.load_pem_x509_certificate(APPLE_APP_ATTESTATION_ROOT_CA_PEM)
    except ValueError as exc:
        raise _fail("invalid_x5c_certificate") from exc

    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        raise _fail("invalid_verification_time")
    moment = moment.astimezone(timezone.utc)
    for certificate in (leaf, intermediate, root):
        _certificate_valid_at(certificate, moment)
        _reject_unknown_critical_extensions(certificate)

    _require_basic_constraints(leaf, ca=False)
    _require_basic_constraints(intermediate, ca=True)
    _require_basic_constraints(root, ca=True)
    _require_key_usage(leaf, ca=False)
    _require_key_usage(intermediate, ca=True)
    _require_key_usage(root, ca=True)

    _verify_certificate_signature(leaf, intermediate)
    _verify_certificate_signature(intermediate, root)
    _verify_certificate_signature(root, root)
    _validate_aki_ski(leaf, intermediate)
    _validate_aki_ski(intermediate, root)

    leaf_key = leaf.public_key()
    if not isinstance(leaf_key, ec.EllipticCurvePublicKey) or not isinstance(
        leaf_key.curve, ec.SECP256R1
    ):
        raise _fail("invalid_attestation_public_key")
    return leaf


def _read_der_length(data: bytes, offset: int) -> tuple[int, int]:
    if offset >= len(data):
        raise _fail("invalid_nonce_extension")
    initial = data[offset]
    offset += 1
    if initial < 0x80:
        return initial, offset
    width = initial & 0x7F
    if width == 0 or width > 4 or offset + width > len(data):
        raise _fail("invalid_nonce_extension")
    if data[offset] == 0:
        raise _fail("invalid_nonce_extension")
    length = int.from_bytes(data[offset : offset + width], "big")
    if length < 0x80:
        raise _fail("invalid_nonce_extension")
    return length, offset + width


def _read_der_tlv(data: bytes, offset: int, expected_tag: int) -> tuple[bytes, int]:
    if offset >= len(data) or data[offset] != expected_tag:
        raise _fail("invalid_nonce_extension")
    length, value_offset = _read_der_length(data, offset + 1)
    end = value_offset + length
    if end > len(data):
        raise _fail("invalid_nonce_extension")
    return data[value_offset:end], end


def _extract_nonce(certificate: x509.Certificate) -> bytes:
    try:
        extension = certificate.extensions.get_extension_for_oid(
            _NONCE_EXTENSION_OID
        ).value
    except x509.ExtensionNotFound as exc:
        raise _fail("missing_nonce_extension") from exc
    if not isinstance(extension, x509.UnrecognizedExtension):
        raise _fail("invalid_nonce_extension")

    sequence, end = _read_der_tlv(extension.value, 0, 0x30)
    if end != len(extension.value):
        raise _fail("invalid_nonce_extension")
    context, end = _read_der_tlv(sequence, 0, 0xA1)
    if end != len(sequence):
        raise _fail("invalid_nonce_extension")
    nonce, end = _read_der_tlv(context, 0, 0x04)
    if end != len(context) or len(nonce) != 32:
        raise _fail("invalid_nonce_extension")
    return nonce


def _parse_attested_authenticator_data(auth_data: bytes) -> _AttestedAuthenticatorData:
    if not isinstance(auth_data, bytes) or not (88 <= len(auth_data) <= 4096):
        raise _fail("invalid_attestation_auth_data")
    rp_id_hash = auth_data[:32]
    flags = auth_data[32]
    counter = int.from_bytes(auth_data[33:37], "big")
    if not (flags & 0x40) or (flags & 0x80):
        raise _fail("invalid_attestation_flags")
    aaguid = auth_data[37:53]
    credential_length = int.from_bytes(auth_data[53:55], "big")
    credential_end = 55 + credential_length
    if credential_length != 32 or credential_end >= len(auth_data):
        raise _fail("invalid_credential_id")
    credential_id = auth_data[55:credential_end]

    credential_tail = auth_data[credential_end:]
    cose_key, cose_length = _decode_cbor_prefix_strict(credential_tail)
    if not isinstance(cose_key, dict) or set(cose_key) != {1, 3, -1, -2, -3}:
        raise _fail("invalid_credential_public_key")

    bundle_version: str | None = None
    validation_category: bytes | None = None
    metadata_bytes = credential_tail[cose_length:]
    if metadata_bytes:
        metadata = _decode_cbor_strict(metadata_bytes)
        if not isinstance(metadata, dict) or set(metadata) != {
            "apple_bundle_version_01",
            "apple_validation_category_01",
        }:
            raise _fail("invalid_attestation_metadata")
        bundle_version = metadata.get("apple_bundle_version_01")
        validation_category = metadata.get("apple_validation_category_01")
        if (
            not isinstance(bundle_version, str)
            or not bundle_version
            or len(bundle_version) > 64
            or not isinstance(validation_category, bytes)
            or len(validation_category) != 4
        ):
            raise _fail("invalid_attestation_metadata")
    if (
        cose_key.get(1) != 2
        or cose_key.get(3) != -7
        or cose_key.get(-1) != 1
        or not isinstance(cose_key.get(-2), bytes)
        or not isinstance(cose_key.get(-3), bytes)
        or len(cose_key[-2]) != 32
        or len(cose_key[-3]) != 32
    ):
        raise _fail("invalid_credential_public_key")

    return _AttestedAuthenticatorData(
        rp_id_hash=rp_id_hash,
        flags=flags,
        counter=counter,
        aaguid=aaguid,
        credential_id=credential_id,
        credential_public_key_x=cose_key[-2],
        credential_public_key_y=cose_key[-3],
        bundle_version=bundle_version,
        validation_category=validation_category,
    )


def _expected_aaguid(
    environment: Literal["production", "development", "sandbox"],
) -> bytes:
    values = {
        "production": _PRODUCTION_AAGUID,
        "development": _DEVELOPMENT_AAGUID,
        "sandbox": _SANDBOX_AAGUID,
    }
    try:
        return values[environment]
    except (KeyError, TypeError) as exc:
        raise _fail("invalid_app_attest_environment") from exc


def verify_attestation(
    attestation_object: bytes,
    *,
    key_id: str,
    challenge: bytes | None = None,
    client_data_hash: bytes | None = None,
    team_id: str,
    bundle_id: str,
    environment: Literal["production", "development", "sandbox"],
    expected_bundle_version: str | None = None,
    expected_validation_category: int | None = None,
    _verification_time: datetime | None = None,
) -> AttestationVerificationResult:
    """Verify one Apple App Attest attestation and return durable key material.

    Supply exactly one of ``challenge`` (the verifier hashes it with SHA-256) or
    ``client_data_hash`` (the exact bytes passed to Apple's ``attestKey`` API).
    Consume the corresponding one-time challenge atomically only after this
    function succeeds and the returned key/counter are durably stored.

    When Apple includes its distributed-app metadata, callers may pin the
    expected build version and validation category. ``_verification_time`` is a
    test-only seam for Apple's short-lived published fixture; production code
    must omit it so certificate validity uses the current UTC time.
    """

    if (challenge is None) == (client_data_hash is None):
        raise _fail("ambiguous_attestation_client_data")
    if challenge is not None:
        if not isinstance(challenge, bytes) or not (16 <= len(challenge) <= 1024):
            raise _fail("invalid_attestation_challenge")
        effective_client_data_hash = hashlib.sha256(challenge).digest()
    else:
        if (
            not isinstance(client_data_hash, bytes)
            or not (16 <= len(client_data_hash) <= 1024)
        ):
            raise _fail("invalid_attestation_client_data_hash")
        effective_client_data_hash = client_data_hash
    decoded = _decode_cbor_strict(attestation_object)
    if not isinstance(decoded, dict) or set(decoded) != {"fmt", "attStmt", "authData"}:
        raise _fail("invalid_attestation_object")
    if decoded.get("fmt") != "apple-appattest":
        raise _fail("invalid_attestation_format")
    statement = decoded.get("attStmt")
    auth_data = decoded.get("authData")
    if not isinstance(statement, dict) or set(statement) != {"x5c", "receipt"}:
        raise _fail("invalid_attestation_statement")
    receipt = statement.get("receipt")
    if not isinstance(receipt, bytes) or not receipt or len(receipt) > 1_500_000:
        raise _fail("invalid_attestation_receipt")

    raw_key_id = _decode_key_id(key_id)
    parsed_auth = _parse_attested_authenticator_data(auth_data)
    leaf = _validate_certificate_chain(statement.get("x5c"), now=_verification_time)
    leaf_key = leaf.public_key()
    if not isinstance(leaf_key, ec.EllipticCurvePublicKey):
        raise _fail("invalid_attestation_public_key")

    expected_nonce = hashlib.sha256(auth_data + effective_client_data_hash).digest()
    if not hmac.compare_digest(_extract_nonce(leaf), expected_nonce):
        raise _fail("attestation_nonce_mismatch")

    public_point = leaf_key.public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    if not hmac.compare_digest(hashlib.sha256(public_point).digest(), raw_key_id):
        raise _fail("attestation_key_id_mismatch")

    expected_rp_id_hash = hashlib.sha256(_app_id(team_id, bundle_id)).digest()
    if not hmac.compare_digest(parsed_auth.rp_id_hash, expected_rp_id_hash):
        raise _fail("attestation_rp_id_mismatch")
    if parsed_auth.counter != 0:
        raise _fail("attestation_counter_not_zero")
    if not hmac.compare_digest(parsed_auth.aaguid, _expected_aaguid(environment)):
        raise _fail("attestation_aaguid_mismatch")
    if not hmac.compare_digest(parsed_auth.credential_id, raw_key_id):
        raise _fail("attestation_credential_id_mismatch")

    validation_category = (
        int.from_bytes(parsed_auth.validation_category, "little")
        if parsed_auth.validation_category is not None
        else None
    )
    if expected_bundle_version is not None:
        if (
            not isinstance(expected_bundle_version, str)
            or not expected_bundle_version
            or parsed_auth.bundle_version != expected_bundle_version
        ):
            raise _fail("attestation_bundle_version_mismatch")
    if expected_validation_category is not None:
        if (
            not isinstance(expected_validation_category, int)
            or isinstance(expected_validation_category, bool)
            or validation_category != expected_validation_category
        ):
            raise _fail("attestation_validation_category_mismatch")

    # The credential public key embedded in authData must describe the same
    # P-256 point as the credential certificate, not merely a syntactically
    # valid independent key.
    numbers = leaf_key.public_numbers()
    if not (
        hmac.compare_digest(
            parsed_auth.credential_public_key_x, numbers.x.to_bytes(32, "big")
        )
        and hmac.compare_digest(
            parsed_auth.credential_public_key_y, numbers.y.to_bytes(32, "big")
        )
    ):
        raise _fail("attestation_public_key_mismatch")

    return AttestationVerificationResult(
        public_key_pem=leaf_key.public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ),
        receipt=receipt,
        counter=0,
        bundle_version=parsed_auth.bundle_version,
        validation_category=validation_category,
    )


def _load_assertion_public_key(public_key_pem: bytes) -> ec.EllipticCurvePublicKey:
    if (
        not isinstance(public_key_pem, bytes)
        or not public_key_pem
        or len(public_key_pem) > 4096
    ):
        raise _fail("invalid_assertion_public_key")
    try:
        key = serialization.load_pem_public_key(public_key_pem)
    except (TypeError, ValueError) as exc:
        raise _fail("invalid_assertion_public_key") from exc
    if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(
        key.curve, ec.SECP256R1
    ):
        raise _fail("invalid_assertion_public_key")
    return key


def verify_assertion(
    assertion_object: bytes,
    *,
    client_data: bytes,
    public_key_pem: bytes,
    team_id: str,
    bundle_id: str,
    previous_counter: int,
) -> AssertionVerificationResult:
    """Verify an App Attest assertion and return its strictly newer counter.

    ``client_data`` must be the exact canonical bytes the app hashed before it
    called ``generateAssertion``. It should bind a one-time challenge, method,
    path, and request-body hash. The caller must atomically compare/store the
    returned counter and consume the challenge to prevent concurrent replay.
    """

    if not isinstance(client_data, bytes) or not (1 <= len(client_data) <= 65_536):
        raise _fail("invalid_assertion_client_data")
    if (
        not isinstance(previous_counter, int)
        or isinstance(previous_counter, bool)
        or not (0 <= previous_counter <= 0xFFFFFFFF)
    ):
        raise _fail("invalid_previous_counter")

    decoded = _decode_cbor_strict(assertion_object)
    if not isinstance(decoded, dict) or set(decoded) != {"signature", "authenticatorData"}:
        raise _fail("invalid_assertion_object")
    signature = decoded.get("signature")
    auth_data = decoded.get("authenticatorData")
    if not isinstance(signature, bytes) or not (8 <= len(signature) <= 80):
        raise _fail("invalid_assertion_signature")
    if not isinstance(auth_data, bytes) or len(auth_data) != 37:
        raise _fail("invalid_assertion_auth_data")

    rp_id_hash = auth_data[:32]
    flags = auth_data[32]
    counter = int.from_bytes(auth_data[33:37], "big")
    # App Attest doesn't claim WebAuthn user presence. Apple assertions have
    # historically used 0x00, while 0x01 is also harmless if Apple sets UP.
    # Reject attested-credential/extension bits and every other reserved bit.
    if flags not in {0x00, 0x01}:
        raise _fail("invalid_assertion_flags")
    expected_rp_id_hash = hashlib.sha256(_app_id(team_id, bundle_id)).digest()
    if not hmac.compare_digest(rp_id_hash, expected_rp_id_hash):
        raise _fail("assertion_rp_id_mismatch")
    if counter <= previous_counter:
        raise AppAttestReplayError()

    try:
        r, s = decode_dss_signature(signature)
    except ValueError as exc:
        raise _fail("invalid_assertion_signature") from exc
    if (
        not (1 <= r < _P256_ORDER)
        or not (1 <= s < _P256_ORDER)
        or encode_dss_signature(r, s) != signature
    ):
        raise _fail("invalid_assertion_signature")

    key = _load_assertion_public_key(public_key_pem)
    client_data_hash = hashlib.sha256(client_data).digest()
    try:
        key.verify(signature, auth_data + client_data_hash, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature as exc:
        raise _fail("assertion_signature_mismatch") from exc
    return AssertionVerificationResult(counter=counter)


__all__ = [
    "APPLE_APP_ATTESTATION_ROOT_CA_PEM",
    "AppAttestReplayError",
    "AppAttestVerificationError",
    "AssertionVerificationResult",
    "AttestationVerificationResult",
    "verify_assertion",
    "verify_attestation",
]
