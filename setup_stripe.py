"""
سكريبت لإنشاء منتج فطنة واشتراكه الشهري في Stripe.
شغّله مرة واحدة: python3 setup_stripe.py
"""
import json, os, urllib.request, urllib.parse, base64

def get_stripe_keys():
    hostname      = os.environ.get('REPLIT_CONNECTORS_HOSTNAME', '')
    repl_identity = os.environ.get('REPL_IDENTITY', '')
    web_renewal   = os.environ.get('WEB_REPL_RENEWAL', '')

    if repl_identity:   token = f'repl {repl_identity}'
    elif web_renewal:   token = f'depl {web_renewal}'
    else:               return None, None
    if not hostname:    return None, None

    req = urllib.request.Request(
        f'https://{hostname}/api/v2/connection?include_secrets=true&connector_names=stripe',
        headers={'Accept': 'application/json', 'X-Replit-Token': token}
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
    settings = (data.get('items') or [{}])[0].get('settings', {})
    return settings.get('secret') or settings.get('secret_key'), settings.get('webhook_secret')

def stripe_req(method, path, data=None, secret_key=None):
    url  = f'https://api.stripe.com/v1/{path}'
    body = urllib.parse.urlencode(data).encode() if data else None
    tok  = base64.b64encode(f'{secret_key}:'.encode()).decode()
    req  = urllib.request.Request(url, data=body, method=method,
           headers={'Authorization': f'Basic {tok}',
                    'Content-Type':  'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())

def main():
    secret_key, _ = get_stripe_keys()
    if not secret_key:
        print('❌ ما قدرت أجيب Stripe key — تأكد أن Stripe integration متصل')
        return

    print('✅ Stripe key موجود')

    # تحقق إذا المنتج موجود مسبقاً
    existing = stripe_req('GET',
        'products/search?query=name%3A%22%D9%81%D8%B7%D9%86%D8%A9%22%20AND%20active%3A%22true%22',
        secret_key=secret_key)
    if existing.get('data'):
        prod = existing['data'][0]
        print(f'ℹ️  المنتج موجود مسبقاً: {prod["name"]} ({prod["id"]})')
        prices = stripe_req('GET', f'prices?product={prod["id"]}&active=true&limit=1',
                            secret_key=secret_key)
        if prices.get('data'):
            price = prices['data'][0]
            print(f'ℹ️  السعر: ${price["unit_amount"]/100:.2f}/{price["recurring"]["interval"]} ({price["id"]})')
        return

    # أنشئ المنتج
    product = stripe_req('POST', 'products', {
        'name':        'فطنة',
        'description': 'لعبة الذكاء والفطنة الجماعية — اشتراك شهري يفتح كل الميزات',
    }, secret_key)
    print(f'✅ تم إنشاء المنتج: {product["name"]} ({product["id"]})')

    # أنشئ السعر الشهري
    price = stripe_req('POST', 'prices', {
        'product':             product['id'],
        'unit_amount':         '399',   # $3.99
        'currency':            'usd',
        'recurring[interval]': 'month',
    }, secret_key)
    print(f'✅ تم إنشاء السعر: $3.99/شهر ({price["id"]})')
    print()
    print('🎉 جاهز! الآن يمكن للمستخدمين الاشتراك.')

if __name__ == '__main__':
    main()
