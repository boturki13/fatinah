import base64
import hashlib
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import cbor2
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import app_attest
from app_attest import (
    APPLE_APP_ATTESTATION_ROOT_CA_PEM,
    AppAttestReplayError,
    AppAttestVerificationError,
    verify_assertion,
    verify_attestation,
)


TEAM_ID = "ABCDEFGHIJ"
BUNDLE_ID = "com.fatinah.game"


def public_key_pem(private_key: ec.EllipticCurvePrivateKey) -> bytes:
    return private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def assertion_auth_data(counter: int, *, team_id: str = TEAM_ID) -> bytes:
    rp_id_hash = hashlib.sha256(f"{team_id}.{BUNDLE_ID}".encode("ascii")).digest()
    return rp_id_hash + b"\x01" + counter.to_bytes(4, "big")


def signed_assertion(
    private_key: ec.EllipticCurvePrivateKey,
    client_data: bytes,
    *,
    counter: int,
) -> bytes:
    auth_data = assertion_auth_data(counter)
    client_data_hash = hashlib.sha256(client_data).digest()
    signature = private_key.sign(
        auth_data + client_data_hash,
        ec.ECDSA(hashes.SHA256()),
    )
    return cbor2.dumps(
        {"signature": signature, "authenticatorData": auth_data},
        canonical=True,
    )


class AssertionVerificationTests(unittest.TestCase):
    def setUp(self):
        self.private_key = ec.generate_private_key(ec.SECP256R1())
        self.public_key = public_key_pem(self.private_key)
        self.client_data = (
            b'{"challenge":"one-time","method":"POST",'
            b'"path":"/api/free-round/complete","bodySHA256":"abc"}'
        )

    def test_accepts_valid_p256_assertion_and_returns_new_counter(self):
        result = verify_assertion(
            signed_assertion(self.private_key, self.client_data, counter=7),
            client_data=self.client_data,
            public_key_pem=self.public_key,
            team_id=TEAM_ID,
            bundle_id=BUNDLE_ID,
            previous_counter=6,
        )

        self.assertEqual(result.counter, 7)

    def test_rejects_replayed_counter(self):
        assertion = signed_assertion(self.private_key, self.client_data, counter=7)

        with self.assertRaises(AppAttestReplayError):
            verify_assertion(
                assertion,
                client_data=self.client_data,
                public_key_pem=self.public_key,
                team_id=TEAM_ID,
                bundle_id=BUNDLE_ID,
                previous_counter=7,
            )

    def test_accepts_apple_assertion_flags_without_user_presence(self):
        auth_data = assertion_auth_data(1)
        auth_data = auth_data[:32] + b"\x00" + auth_data[33:]
        client_data_hash = hashlib.sha256(self.client_data).digest()
        signature = self.private_key.sign(
            auth_data + client_data_hash, ec.ECDSA(hashes.SHA256())
        )
        assertion = cbor2.dumps(
            {"signature": signature, "authenticatorData": auth_data},
            canonical=True,
        )

        result = verify_assertion(
            assertion,
            client_data=self.client_data,
            public_key_pem=self.public_key,
            team_id=TEAM_ID,
            bundle_id=BUNDLE_ID,
            previous_counter=0,
        )

        self.assertEqual(result.counter, 1)

    def test_rejects_client_data_substitution(self):
        assertion = signed_assertion(self.private_key, self.client_data, counter=1)

        with self.assertRaisesRegex(
            AppAttestVerificationError, "assertion_signature_mismatch"
        ):
            verify_assertion(
                assertion,
                client_data=b"different request",
                public_key_pem=self.public_key,
                team_id=TEAM_ID,
                bundle_id=BUNDLE_ID,
                previous_counter=0,
            )

    def test_rejects_wrong_rp_id(self):
        assertion = signed_assertion(self.private_key, self.client_data, counter=1)

        with self.assertRaisesRegex(
            AppAttestVerificationError, "assertion_rp_id_mismatch"
        ):
            verify_assertion(
                assertion,
                client_data=self.client_data,
                public_key_pem=self.public_key,
                team_id="WRONGTEAM1",
                bundle_id=BUNDLE_ID,
                previous_counter=0,
            )

    def test_rejects_non_p256_key(self):
        p384_key = ec.generate_private_key(ec.SECP384R1())
        assertion = signed_assertion(self.private_key, self.client_data, counter=1)

        with self.assertRaisesRegex(
            AppAttestVerificationError, "invalid_assertion_public_key"
        ):
            verify_assertion(
                assertion,
                client_data=self.client_data,
                public_key_pem=public_key_pem(p384_key),
                team_id=TEAM_ID,
                bundle_id=BUNDLE_ID,
                previous_counter=0,
            )


class StrictCBORTests(unittest.TestCase):
    def test_rejects_trailing_data(self):
        private_key = ec.generate_private_key(ec.SECP256R1())
        assertion = signed_assertion(private_key, b"request", counter=1) + b"\x00"

        with self.assertRaisesRegex(
            AppAttestVerificationError, "cbor_trailing_data"
        ):
            verify_assertion(
                assertion,
                client_data=b"request",
                public_key_pem=public_key_pem(private_key),
                team_id=TEAM_ID,
                bundle_id=BUNDLE_ID,
                previous_counter=0,
            )

    def test_rejects_indefinite_length_container(self):
        with self.assertRaisesRegex(
            AppAttestVerificationError, "cbor_noncanonical"
        ):
            app_attest._decode_cbor_strict(b"\xbf\xff")

    def test_rejects_duplicate_map_keys_before_cbor2_decodes_them(self):
        auth_data = assertion_auth_data(1)
        duplicate_key_map = (
            b"\xa3"
            b"\x69signature\x41\x00"
            b"\x69signature\x41\x01"
            b"\x71authenticatorData\x58\x25"
            + auth_data
        )

        with self.assertRaisesRegex(
            AppAttestVerificationError, "cbor_duplicate_key"
        ):
            app_attest._decode_cbor_strict(duplicate_key_map)

    def test_rejects_nonminimal_integer_encoding(self):
        with self.assertRaisesRegex(
            AppAttestVerificationError, "cbor_noncanonical"
        ):
            app_attest._decode_cbor_strict(b"\x18\x01")


class AttestationVerificationTests(unittest.TestCase):
    def test_accepts_apples_documented_2026_attestation_fixture(self):
        # Source: Apple's Attestation Object Validation Guide. The leaf
        # certificate is intentionally short-lived, so verify at its documented
        # issuance time rather than wall-clock time.
        fixture_path = (
            Path(__file__).parent / "fixtures" / "apple_app_attest_sample.b64"
        )
        attestation = base64.b64decode(fixture_path.read_bytes(), validate=False)

        result = verify_attestation(
            attestation,
            key_id="zgSY9YSD+7TaDXssY6WlOPVS1K3Lmk+pFhlcSWE+ZV0=",
            client_data_hash=b"example_server_challenge",
            team_id="1234567890",
            bundle_id="com.example.myapp",
            environment="production",
            expected_bundle_version="1",
            expected_validation_category=1,
            _verification_time=datetime(2026, 4, 21, 18, 13, 12, tzinfo=timezone.utc),
        )

        self.assertEqual(result.counter, 0)
        self.assertTrue(result.public_key_pem.startswith(b"-----BEGIN PUBLIC KEY-----"))
        self.assertGreater(len(result.receipt), 1_000)
        self.assertEqual(result.bundle_version, "1")
        self.assertEqual(result.validation_category, 1)

    def test_embedded_root_is_the_official_apple_app_attestation_root(self):
        root = x509.load_pem_x509_certificate(APPLE_APP_ATTESTATION_ROOT_CA_PEM)
        common_name = root.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value

        self.assertEqual(common_name, "Apple App Attestation Root CA")
        self.assertEqual(root.issuer, root.subject)

    def test_rejects_wrong_attestation_format_before_certificate_processing(self):
        malformed = cbor2.dumps(
            {
                "fmt": "packed",
                "attStmt": {"x5c": [b"a", b"b"], "receipt": b"receipt"},
                "authData": b"x" * 88,
            },
            canonical=True,
        )

        with self.assertRaisesRegex(
            AppAttestVerificationError, "invalid_attestation_format"
        ):
            verify_attestation(
                malformed,
                key_id=base64.b64encode(b"k" * 32).decode("ascii"),
                challenge=b"challenge-at-least-16-bytes",
                team_id=TEAM_ID,
                bundle_id=BUNDLE_ID,
                environment="production",
            )

    def test_rejects_synthetic_untrusted_chain(self):
        private_key = ec.generate_private_key(ec.SECP256R1())
        point = private_key.public_key().public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint,
        )
        raw_key_id = hashlib.sha256(point).digest()
        key_id = base64.b64encode(raw_key_id).decode("ascii")
        cose_key = cbor2.dumps(
            {
                1: 2,
                3: -7,
                -1: 1,
                -2: private_key.public_key().public_numbers().x.to_bytes(32, "big"),
                -3: private_key.public_key().public_numbers().y.to_bytes(32, "big"),
            },
            canonical=True,
        )
        auth_data = (
            hashlib.sha256(f"{TEAM_ID}.{BUNDLE_ID}".encode("ascii")).digest()
            + b"\x41"
            + b"\x00\x00\x00\x00"
            + b"appattest"
            + (b"\x00" * 7)
            + len(raw_key_id).to_bytes(2, "big")
            + raw_key_id
            + cose_key
        )
        challenge = b"challenge-at-least-16-bytes"
        nonce = hashlib.sha256(auth_data + hashlib.sha256(challenge).digest()).digest()
        nonce_extension = b"\x30\x24\xa1\x22\x04\x20" + nonce
        subject = issuer = x509.Name(
            [x509.NameAttribute(NameOID.COMMON_NAME, "Synthetic Untrusted CA")]
        )
        now = datetime.now(timezone.utc)
        certificate = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(private_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(minutes=10))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(
                x509.KeyUsage(
                    digital_signature=True,
                    content_commitment=False,
                    key_encipherment=False,
                    data_encipherment=False,
                    key_agreement=False,
                    key_cert_sign=False,
                    crl_sign=False,
                    encipher_only=None,
                    decipher_only=None,
                ),
                critical=True,
            )
            .add_extension(
                x509.UnrecognizedExtension(
                    x509.ObjectIdentifier("1.2.840.113635.100.8.2"), nonce_extension
                ),
                critical=False,
            )
            .sign(private_key, hashes.SHA256())
        )
        certificate_der = certificate.public_bytes(serialization.Encoding.DER)
        attestation = cbor2.dumps(
            {
                "fmt": "apple-appattest",
                "attStmt": {
                    "x5c": [certificate_der, certificate_der],
                    "receipt": b"synthetic-receipt",
                },
                "authData": auth_data,
            },
            canonical=True,
        )

        with self.assertRaises(AppAttestVerificationError):
            verify_attestation(
                attestation,
                key_id=key_id,
                challenge=challenge,
                team_id=TEAM_ID,
                bundle_id=BUNDLE_ID,
                environment="production",
                _verification_time=now,
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
