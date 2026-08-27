#!/usr/bin/env python3
"""عقد يمنع كسر v1 أثناء طرح v2 في staging ثم production."""
import json
import http.client
import os
import re
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ['FATINAH_ENVIRONMENT'] = 'staging'
os.environ['FIREBASE_APP_CHECK_ENFORCE'] = 'false'
for key in (
    'FATINAH_V1_APP_CHECK_ENFORCE',
    'FATINAH_V2_APP_CHECK_ENFORCE',
    'FATINAH_V2_APP_ATTEST_ENFORCE',
    'FATINAH_V2_DEVICECHECK_ENFORCE',
    'FATINAH_V2_FEATURE_APP_ATTEST_ENABLED',
    'FATINAH_V2_FEATURE_FREE_ROUND_ENABLED',
    'FATINAH_V1_GENERATION_URL',
    'FATINAH_V1_GENERATION_ALLOWED_HOSTS',
    'FATINAH_V1_AI_GENERATION_ENABLED',
):
    os.environ.pop(key, None)

sys.path.insert(0, str(ROOT))
import server as srv

log_secret = 'private-user@example.com:+96590999731:raw-token'
log_reference = srv.safe_log_reference(log_secret)
assert log_secret not in log_reference
assert re.fullmatch(r'[0-9a-f]{12}', log_reference)
assert srv.safe_log_reference('') == 'none'
assert srv.exception_kind(RuntimeError(log_secret)) == 'RuntimeError'

tmp_db = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
tmp_db.close()
srv.DB_PATH = tmp_db.name
srv.init_db()
srv.uid_matches_token = lambda uid, token: uid == 'contract-user' and token == 'TOKEN'

real_legacy_generation = srv.legacy_generate_questions
status, payload = real_legacy_generation({})
assert status == 503 and payload['code'] == 'legacy_feature_disabled'
os.environ['FATINAH_V1_AI_GENERATION_ENABLED'] = 'true'
status, payload = real_legacy_generation({})
assert status == 401 and status != 410
status, payload = real_legacy_generation({
    'uid': 'contract-user', 'idToken': 'WRONG', 'topic': 'علوم', 'count': 4,
})
assert status == 401
status, payload = real_legacy_generation({
    'uid': 'contract-user', 'idToken': 'TOKEN', 'topic': 'علوم', 'count': 4,
})
assert status == 403  # لا اشتراك، ولا وصول إلى المزود
os.environ['FATINAH_V1_AI_GENERATION_ENABLED'] = 'false'
status, payload = real_legacy_generation({})
assert status == 503 and payload['code'] == 'legacy_feature_disabled'
os.environ['FATINAH_V1_AI_GENERATION_ENABLED'] = 'true'

# تحقق ترتيب الحواجز قبل أي اتصال خارجي، وعزل وجهة production عن staging.
original_subscription_is_active = srv.subscription_is_active
original_rate_limited = srv.rate_limited
original_open_legacy = srv._open_legacy_generation_request
original_resolver = srv._hostname_resolves_to_public_ips
rate_checks = []
upstream_requests = []
srv.subscription_is_active = lambda uid: uid == 'contract-user'


def fake_rate_limit(key, max_calls, window):
    rate_checks.append((key, max_calls, window))
    return True


srv.rate_limited = fake_rate_limit
status, payload = real_legacy_generation({
    'uid': 'contract-user', 'idToken': 'TOKEN', 'topic': 'علوم', 'count': 4,
})
assert status == 429
assert rate_checks == [('legacy-ai:contract-user', 10, 600)]

srv.rate_limited = lambda *_args: False
os.environ['FATINAH_V1_GENERATION_URL'] = srv.LEGACY_V1_GENERATION_URL
srv._open_legacy_generation_request = (
    lambda *args, **kwargs: upstream_requests.append((args, kwargs)))
status, payload = real_legacy_generation({
    'uid': 'contract-user', 'idToken': 'TOKEN', 'topic': 'علوم', 'count': 4,
})
assert status == 503 and payload['code'] == 'legacy_backend_misconfigured'
assert not upstream_requests  # staging لا يرسل token إلى production


class FakeUpstreamResponse:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit=-1):
        return json.dumps({
            'questions': [{
                'q': 'سؤال آمن؟', 'answer': 'نعم',
                'providerTrace': 'UPSTREAM_SECRET_SENTINEL',
            }],
            'debug': 'UPSTREAM_SECRET_SENTINEL',
        }).encode()


def fake_urlopen(request_object, timeout=0):
    upstream_requests.append((request_object, timeout))
    return FakeUpstreamResponse()


os.environ['FATINAH_V1_GENERATION_URL'] = (
    'https://api.staging.example.invalid/generateQuestions')
os.environ['FATINAH_V1_GENERATION_ALLOWED_HOSTS'] = (
    'api.staging.example.invalid')
srv._hostname_resolves_to_public_ips = (
    lambda host, port: host == 'api.staging.example.invalid' and port == 443)
srv._open_legacy_generation_request = fake_urlopen
status, payload = real_legacy_generation({
    'uid': 'contract-user', 'idToken': 'TOKEN', 'topic': 'علوم', 'count': 4,
})
assert status == 200 and payload['questions'][0]['answer'] == 'نعم'
assert 'UPSTREAM_SECRET_SENTINEL' not in json.dumps(payload)
assert len(upstream_requests) == 1
forwarded_request, forwarded_timeout = upstream_requests[0]
assert forwarded_request.full_url.startswith('https://api.staging.example.invalid/')
assert forwarded_request.get_header('Authorization') is None
assert forwarded_request.get_header('X-fatinah-api-version') == '1'
forwarded_body = json.loads(forwarded_request.data)
assert forwarded_body['idToken'] == 'TOKEN'
assert json.dumps(forwarded_body).count('TOKEN') == 1
assert forwarded_timeout == srv.LEGACY_GENERATION_TIMEOUT_SECONDS

# Host مسموح اسماً لكنه يحل إلى private/link-local يُرفض قبل فتح الشبكة.
upstream_requests.clear()
os.environ['FATINAH_V1_GENERATION_URL'] = (
    'https://private.staging.example.invalid/generateQuestions')
os.environ['FATINAH_V1_GENERATION_ALLOWED_HOSTS'] = (
    'private.staging.example.invalid')
srv._hostname_resolves_to_public_ips = lambda _host, _port: False
status, payload = real_legacy_generation({
    'uid': 'contract-user', 'idToken': 'TOKEN', 'topic': 'علوم', 'count': 4,
})
assert status == 503 and payload['code'] == 'legacy_backend_misconfigured'
assert not upstream_requests

srv.subscription_is_active = original_subscription_is_active
srv.rate_limited = original_rate_limited
srv._open_legacy_generation_request = original_open_legacy
srv._hostname_resolves_to_public_ips = original_resolver
os.environ.pop('FATINAH_V1_GENERATION_URL', None)
os.environ.pop('FATINAH_V1_GENERATION_ALLOWED_HOSTS', None)

# هذا اختبار routing لا مزوّد الذكاء الاصطناعي؛ يحاكي upstream ناجحاً ويثبت
# أن v1 يصل إليه، بينما v2 يتقاعد باسمه/مساره المنفصل.
legacy_calls = []


def fake_legacy_generation(data):
    legacy_calls.append(data)
    return 200, {'questions': [{'q': 'سؤال v1؟', 'answer': 'إجابة'}]}


srv.legacy_generate_questions = fake_legacy_generation

httpd = HTTPServer(('127.0.0.1', 0), srv.Handler)
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(0.05)
base = f'http://127.0.0.1:{port}'


def request(method, path, payload=None, headers=None):
    body = json.dumps(payload).encode() if payload is not None else None
    request_headers = {'Content-Type': 'application/json'}
    request_headers.update(headers or {})
    req = urllib.request.Request(
        base + path, data=body, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            raw = response.read()
            return response.status, dict(response.headers), json.loads(raw or b'{}')
    except urllib.error.HTTPError as error:
        raw = error.read()
        return error.code, dict(error.headers), json.loads(raw or b'{}')


def duplicate_version_header_request():
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    connection.putrequest('GET', '/api/version')
    connection.putheader('X-Fatinah-API-Version', '1')
    connection.putheader('X-Fatinah-API-Version', '2')
    connection.endheaders()
    response = connection.getresponse()
    result = response.status, json.loads(response.read() or b'{}')
    connection.close()
    return result


try:
    assert srv.legacy_v1_generation_url() == ''  # staging لا يتصل بـproduction ضمنياً
    os.environ.pop('FATINAH_ENVIRONMENT', None)
    assert srv.legacy_v1_generation_url() == ''  # الغياب لا يعني production
    assert srv.deployment_environment() == 'unconfigured'
    assert srv.v2_feature_enabled('free_round') is False
    os.environ['FATINAH_ENVIRONMENT'] = 'staging'

    contract_paths = (
        '/api/account/delete', '/api/account/profile',
        '/api/free-round/status', '/api/free-round/complete',
        '/api/questions/seen', '/api/questions/round', '/api/questions/report',
        '/api/metrics/event', '/api/ios-diagnostics',
        '/api/revenuecat/identity', '/api/revenuecat/webhook',
        '/api/subscription/status', '/api/generate',
    )
    for canonical in contract_paths:
        suffix = canonical[len('/api'):]
        assert srv.resolve_api_contract(canonical, {}) == (canonical, '1')
        assert srv.resolve_api_contract('/api/v1' + suffix, {}) == (canonical, '1')
        assert srv.resolve_api_contract('/api/v2' + suffix, {}) == (canonical, '2')
        assert srv.resolve_api_contract(
            canonical, {'X-Fatinah-API-Version': '2'}) == (canonical, '2')
    try:
        srv.resolve_api_contract(
            '/api/version', {'X-Fatinah-API-Version': '1, 2'})
        raise AssertionError('قُبل رأس إصدار مركب')
    except ValueError:
        pass

    # المسار غير المرقم و/v1 عقد واحد، أما /v2 والرأس فهما اختيار صريح.
    status, headers, unversioned = request('GET', '/api/version')
    assert status == 200 and headers['X-Fatinah-API-Version'] == '1'
    status, headers, explicit_v1 = request('GET', '/api/v1/version')
    assert status == 200 and headers['X-Fatinah-API-Version'] == '1'
    assert explicit_v1 == unversioned

    status, headers, explicit_v2 = request('GET', '/api/v2/version')
    assert status == 200 and headers['X-Fatinah-API-Version'] == '2'
    assert explicit_v2['apiVersion'] == '2'
    assert explicit_v2['environment'] == 'staging'
    assert explicit_v2['features']['free_round'] is True

    # تطبيق Capacitor يستدعي الخادم من capacitor://localhost، وإضافة رمز
    # DeviceCheck إلى GET تفرض CORS preflight. يجب السماح بالرأس صراحةً وإلا
    # لن يصل طلب التحقق الحقيقي إلى الخادم على الجهاز.
    status, headers, _ = request(
        'OPTIONS', '/api/v2/free-round/status', headers={
            'Origin': 'capacitor://localhost',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': (
                'authorization,x-devicecheck-token,x-fatinah-api-version'
            ),
        })
    assert status == 204
    allowed_headers = {
        item.strip().lower()
        for item in headers['Access-Control-Allow-Headers'].split(',')
    }
    assert {
        'authorization', 'x-devicecheck-token', 'x-fatinah-api-version'
    }.issubset(allowed_headers)

    status, _, unknown_v2 = request('GET', '/api/v2/not-a-real-route')
    assert status == 404 and unknown_v2['code'] == 'unsupported_v2_route'
    status, _, unknown_v2_post = request(
        'POST', '/api/v2/promo/legacy', {'code': 'OLD'})
    assert status == 404 and unknown_v2_post['code'] == 'unsupported_v2_route'
    status, _, unknown_v2_options = request(
        'OPTIONS', '/api/v2/not-a-real-route')
    assert status == 404 and unknown_v2_options['code'] == 'unsupported_v2_route'

    # ميزات 1.3 لا يمكن الوصول إليها بعقد v1 لتجاوز حمايات v2.
    for v2_only_path in srv.V2_ONLY_ROUTES:
        status, _, result = request('GET', v2_only_path)
        assert status == 404 and result['code'] == 'v2_route_required'
        status, _, result = request(
            'POST', '/api/v1' + v2_only_path[len('/api'):], {})
        assert status == 404 and result['code'] == 'v2_route_required'

    status, headers, header_v2 = request(
        'GET', '/api/version', headers={'X-Fatinah-API-Version': '2'})
    assert status == 200 and headers['X-Fatinah-API-Version'] == '2'
    assert header_v2 == explicit_v2

    status, _, conflict = request(
        'GET', '/api/v1/version', headers={'X-Fatinah-API-Version': '2'})
    assert status == 400 and conflict['code'] == 'unsupported_api_version'
    status, _, unsupported = request(
        'GET', '/api/version', headers={'X-Fatinah-API-Version': '99'})
    assert status == 400 and unsupported['code'] == 'unsupported_api_version'
    status, duplicate = duplicate_version_header_request()
    assert status == 400 and duplicate['code'] == 'unsupported_api_version'

    os.environ['REVENUECAT_WEBHOOK_SECRET'] = 'DO_NOT_LEAK_SENTINEL'
    status, _, public_capabilities = request('GET', '/api/v2/version')
    assert status == 200
    assert 'DO_NOT_LEAK_SENTINEL' not in json.dumps(public_capabilities)
    os.environ.pop('REVENUECAT_WEBHOOK_SECRET', None)

    auth = {'Authorization': 'Bearer TOKEN'}
    endpoint = '/api/free-round/status?uid=contract-user'
    status, _, v1_round = request('GET', endpoint, headers=auth)
    assert status == 404 and v1_round['code'] == 'v2_route_required'
    status, _, explicit_v1_round = request(
        'GET', endpoint.replace('/api/', '/api/v1/'), headers=auth)
    assert status == 404 and explicit_v1_round['code'] == 'v2_route_required'
    status, headers, v2_round = request(
        'GET', endpoint.replace('/api/', '/api/v2/'), headers=auth)
    assert status == 200 and headers['X-Fatinah-API-Version'] == '2'
    assert v2_round == {'eligible': True, 'completed': False}

    # أعلام v2 مغلقة افتراضياً في production، ومسارات 1.3 لا تنخفض إلى v1.
    os.environ['FATINAH_ENVIRONMENT'] = 'production'
    assert srv.legacy_v1_generation_url().startswith('https://')
    os.environ.pop('FATINAH_V2_FEATURE_FREE_ROUND_ENABLED', None)
    status, _, disabled = request(
        'GET', endpoint.replace('/api/', '/api/v2/'), headers=auth)
    assert status == 503 and disabled['code'] == 'feature_disabled'
    status, _, still_v1 = request('GET', endpoint, headers=auth)
    assert status == 404 and still_v1['code'] == 'v2_route_required'

    # خطأ كتابة اسم البيئة يفشل مغلقاً كـproduction ولا يفعّل مزايا staging.
    os.environ['FATINAH_ENVIRONMENT'] = 'prodution'
    assert srv.legacy_v1_generation_url() == ''
    os.environ['FATINAH_V1_GENERATION_URL'] = srv.LEGACY_V1_GENERATION_URL
    assert not srv._legacy_generation_endpoint_is_safe(
        srv.legacy_v1_generation_url())
    os.environ.pop('FATINAH_V1_GENERATION_URL', None)
    status, headers, typo_environment = request('GET', '/api/v2/version')
    assert status == 200 and headers['X-Fatinah-Environment'] == 'invalid'
    assert typo_environment['features']['free_round'] is False
    os.environ['FATINAH_ENVIRONMENT'] = 'production'
    os.environ['FATINAH_V2_FEATURE_FREE_ROUND_ENABLED'] = 'true'
    assert srv.app_attest_enforcement_enabled('2') is True
    status, _, app_attest_protected = request(
        'GET', endpoint.replace('/api/', '/api/v2/'), headers=auth)
    assert status == 401
    assert app_attest_protected['code'] == 'app_attest_context_mismatch'

    # بقية هذا القسم يعزل عقد DeviceCheck؛ التحقق المباشر لـApp Attest له
    # اختبار تكامل مستقل يغطي التسجيل والتحدي والـassertion ومنع إعادة التشغيل.
    os.environ['FATINAH_V2_APP_ATTEST_ENFORCE'] = 'false'
    assert srv.devicecheck_enforcement_enabled('2') is True
    status, _, devicecheck_protected = request(
        'GET', endpoint.replace('/api/', '/api/v2/'), headers=auth)
    assert status == 401 and devicecheck_protected['code'] == 'device_check_missing'
    # بقية هذا الملف يختبر عقد النسخ لا DeviceCheck؛ له اختبار تكامل مستقل.
    os.environ['FATINAH_V2_DEVICECHECK_ENFORCE'] = 'false'
    status, _, enabled = request(
        'GET', endpoint.replace('/api/', '/api/v2/'), headers=auth)
    assert status == 200 and enabled == {'eligible': True, 'completed': False}

    # لا يمكن تخفيف حماية مسار 1.3 باختيار v1، وإنفاذ App Check يخص v2.
    os.environ['FIREBASE_APP_CHECK_ENFORCE'] = 'true'
    status, _, still_compatible = request('GET', endpoint, headers=auth)
    assert status == 404 and still_compatible['code'] == 'v2_route_required'
    status, _, protected_v2 = request(
        'GET', endpoint.replace('/api/', '/api/v2/'), headers=auth)
    assert status == 401 and protected_v2['code'] == 'app_check_failed'
    os.environ['FATINAH_V2_APP_CHECK_ENFORCE'] = 'false'
    status, _, v2_override = request(
        'GET', endpoint.replace('/api/', '/api/v2/'), headers=auth)
    assert status == 200 and v2_override == {'eligible': True, 'completed': False}
    os.environ.pop('FATINAH_V2_APP_CHECK_ENFORCE', None)
    os.environ['FIREBASE_APP_CHECK_ENFORCE'] = 'false'

    os.environ['FATINAH_V1_APP_CHECK_ENFORCE'] = 'true'
    status, _, explicitly_protected_v1 = request('GET', endpoint, headers=auth)
    assert status == 404 and explicitly_protected_v1['code'] == 'v2_route_required'
    status, _, independent_v2 = request(
        'GET', endpoint.replace('/api/', '/api/v2/'), headers=auth)
    assert status == 200 and independent_v2 == {'eligible': True, 'completed': False}
    os.environ.pop('FATINAH_V1_APP_CHECK_ENFORCE', None)

    generation_payload = {
        'uid': 'contract-user', 'idToken': 'TOKEN',
        'topic': 'علوم', 'count': 4, 'seen': [],
    }
    status, headers, generated = request(
        'POST', '/api/generate', generation_payload)
    assert status == 200 and headers['X-Fatinah-API-Version'] == '1'
    assert generated['questions'][0]['q'] == 'سؤال v1؟'
    status, headers, retired = request(
        'POST', '/api/v2/generate', generation_payload)
    assert status == 410 and headers['X-Fatinah-API-Version'] == '2'
    assert retired['code'] == 'ai_generation_retired'

    status, _, header_selected_v2 = request(
        'POST', '/api/generate', generation_payload,
        headers={'X-Fatinah-API-Version': '2'})
    assert status == 410 and header_selected_v2['code'] == 'ai_generation_retired'
    status, _, v1_path_v2_header = request(
        'POST', '/api/v1/generate', generation_payload,
        headers={'X-Fatinah-API-Version': '2'})
    assert status == 400 and v1_path_v2_header['code'] == 'unsupported_api_version'
    status, _, v2_path_v1_header = request(
        'POST', '/api/v2/generate', generation_payload,
        headers={'X-Fatinah-API-Version': '1'})
    assert status == 400 and v2_path_v1_header['code'] == 'unsupported_api_version'
    assert len(legacy_calls) == 1

    # حماية اسم Cloud Function القديم بعقد ثابت أيضاً.
    functions_source = (ROOT / 'functions' / 'index.js').read_text(encoding='utf-8')
    assert 'exports.generateQuestions = onRequest' in functions_source
    assert 'generateQuestionsV1Handler' in functions_source
    assert 'secrets: [anthropicKey]' in functions_source
    assert 'exports.generateQuestionsV2 = onRequest' in functions_source
    v1_handler = functions_source.split(
        'async function generateQuestionsV1Handler', 1)[1].split(
            'exports.generateQuestions = onRequest', 1)[0]
    assert 'status(410)' not in v1_handler
    assert 'verifyIdToken' in v1_handler
    assert 'subscriptionActive' in v1_handler
    assert 'checkRateLimit' in v1_handler
    assert v1_handler.index('apiVersionAllows') < v1_handler.index('verifyIdToken')
    assert v1_handler.index('verifyIdToken') < v1_handler.index('checkRateLimit')
    assert v1_handler.index('checkRateLimit') < v1_handler.index(
        'validatedSubscriptionStatusUrl')
    assert v1_handler.index('validatedSubscriptionStatusUrl') < v1_handler.index(
        'https://api.anthropic.com')
    assert 'trustedRound ? 30' not in v1_handler
    assert 'redirect: "manual"' in v1_handler
    assert 'redirect: "error"' in v1_handler
    assert 'envFlag("FATINAH_V1_AI_GENERATION_ENABLED", false)' in v1_handler
    assert 'SUBSCRIPTION_TIMEOUT_MS = 5_000' in functions_source
    assert 'PROVIDER_TIMEOUT_MS = 20_000' in functions_source
    assert 'FUNCTION_TIMEOUT_SECONDS = 40' in functions_source
    v2_handler = functions_source.split(
        'async function generateQuestionsV2Handler', 1)[1].split(
            'exports.generateQuestionsV2 = onRequest', 1)[0]
    assert 'status(410)' in v2_handler
    assert 'fetch(' not in v2_handler
    assert 'anthropicKey' not in v2_handler
    v2_export = functions_source.split(
        'exports.generateQuestionsV2 = onRequest', 1)[1].split(
            'if (process.env.NODE_ENV', 1)[0]
    assert 'secrets:' not in v2_export

    sources_to_scan = '\n'.join((
        (ROOT / 'server.py').read_text(encoding='utf-8'),
        functions_source,
        (ROOT / 'functions' / 'api-contract.js').read_text(encoding='utf-8'),
        (ROOT / 'functions' / 'network-policy.js').read_text(encoding='utf-8'),
        (ROOT / 'functions' / 'trusted-source.js').read_text(encoding='utf-8'),
        (ROOT / 'API_VERSIONING.md').read_text(encoding='utf-8'),
    ))
    for secret_pattern in (
        r'\bsk-ant-[A-Za-z0-9_-]{12,}',
        r'\bsk-proj-[A-Za-z0-9_-]{12,}',
        r'\bAIza[0-9A-Za-z_-]{24,}',
        r'-----BEGIN (?:RSA |EC |)PRIVATE KEY-----',
    ):
        assert not re.search(secret_pattern, sources_to_scan)

    server_source = (ROOT / 'server.py').read_text(encoding='utf-8')
    assert 'uid={uid}' not in server_source
    assert 'rc={rc_app_user_id}' not in server_source
    assert 'localizedDescription' not in sources_to_scan

    print('API v1/v2 compatibility, flags, App Check isolation, and function names: passed')
finally:
    httpd.shutdown()
    os.unlink(tmp_db.name)
