/**
 * apple-redeem.js
 * ----------------
 * يربط خانة إدخال الكود اللي صممتها في تطبيقك بنظام الأكواد الترويجية
 * الفعلي عندك (داخل server.py الحالي، جداول promo_codes/promo_redemptions
 * في subscriptions.db). أنت تنشئ الكود بأي نص تحبه (مثل "NR5") وتحدد كم
 * يوم يعطي، والباك إند يتحقق ويمدد اشتراك العميل — ونتيجة التفعيل توحّدت
 * مع /api/stripe/status، يعني العميل يصير "مشترك فعّال" بنفس الفحص اللي
 * يستخدمه التطبيق أصلًا لمشتركي Stripe.
 *
 * ملاحظة: مشروع Node.js المنفصل (apple-redeem-backend) اللي أُرسل قبل صار
 * غير مستخدم — كل شي الآن داخل نفس سيرفر Python الحالي.
 */

// رابط تطبيق Replit تبعك اللي يشغّل server.py، مثال:
// https://your-repl-name.your-username.repl.co
const BACKEND_URL = 'REPLACE_WITH_YOUR_BACKEND_URL';

/**
 * يحاول يجيب معرّف المستخدم الحالي (uid) من @capacitor-firebase/authentication.
 * إذا ما كان مسجل دخول أو الحزمة مو محمّلة، يرجع null.
 */
async function getCurrentUserId() {
  try {
    const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
    const { user } = await FirebaseAuthentication.getCurrentUser();
    return user?.uid || null;
  } catch {
    return null;
  }
}

/**
 * يرسل الكود لـ /api/promo/redeem، يتحقق منه، ويمدد اشتراك العميل الحالي.
 * @param {string} code - الكود اللي كتبه العميل، مثل "NR5"
 */
export async function redeemCustomCode(code) {
  const trimmed = (code || '').trim();
  if (!trimmed) return { ok: false, message: 'الرجاء إدخال الكود' };

  if (!BACKEND_URL || BACKEND_URL.startsWith('REPLACE_')) {
    return { ok: false, message: 'الباك إند مو مركّب بعد' };
  }

  const uid = await getCurrentUserId();
  if (!uid) return { ok: false, message: 'الرجاء تسجيل الدخول أولًا' };

  try {
    const res = await fetch(`${BACKEND_URL}/api/promo/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: trimmed, uid }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      // السيرفر يرجع رسالة عربية جاهزة في data.error (مثل "الكود غير صحيح")
      return { ok: false, message: data.error || 'تعذر تفعيل الكود' };
    }

    const message = data.already
      ? `الكود مفعّل مسبقًا، ساري حتى ${data.expires_at}`
      : `تم التفعيل بنجاح! ساري حتى ${data.expires_at}`;

    return { ok: true, message, expiresAt: data.expires_at };
  } catch (err) {
    console.warn('تعذر الاتصال بالباك إند:', err);
    return { ok: false, message: 'تعذر الاتصال بالسيرفر، حاول مرة ثانية' };
  }
}

/**
 * يتحقق هل العميل الحالي "مشترك فعّال" الآن — يستخدم /api/stripe/status
 * لأنه أصبح المصدر الموحّد (يرجع true سواء كان الاشتراك عبر Stripe أو
 * عبر كود ترويجي ساري). استدعها عند فتح التطبيق لتحديد إظهار الميزات
 * المدفوعة.
 */
export async function checkPremiumStatus(userId) {
  if (!BACKEND_URL || BACKEND_URL.startsWith('REPLACE_')) {
    return { ok: false, active: false, message: 'الباك إند مو مركّب بعد' };
  }

  const uid = userId || (await getCurrentUserId());
  if (!uid) return { ok: false, active: false, message: 'لا يوجد مستخدم مسجل دخول' };

  try {
    const res = await fetch(`${BACKEND_URL}/api/stripe/status?uid=${encodeURIComponent(uid)}`);
    const data = await res.json();
    return { ok: true, active: !!data.active };
  } catch (err) {
    console.warn('تعذر التحقق من حالة الاشتراك:', err);
    return { ok: false, active: false, message: 'تعذر الاتصال بالباك إند' };
  }
}

/**
 * تفاصيل إضافية عن كود الترويج تحديدًا (تاريخ الانتهاء الخاص بالكود، لو
 * حبيت تعرضه للعميل بشكل منفصل عن الحالة العامة للاشتراك).
 */
export async function getPromoDetails(userId) {
  if (!BACKEND_URL || BACKEND_URL.startsWith('REPLACE_')) return null;

  const uid = userId || (await getCurrentUserId());
  if (!uid) return null;

  try {
    const res = await fetch(`${BACKEND_URL}/api/promo/status?uid=${encodeURIComponent(uid)}`);
    return await res.json(); // { active, expires_at }
  } catch (err) {
    console.warn('تعذر جلب تفاصيل الكود:', err);
    return null;
  }
}

/**
 * مثال ربط بسيط مع عناصر الواجهة اللي عندك (عدّل الـ id حسب ملفك الفعلي)
 *
 * <input id="codeInput" placeholder="أدخل الكود هنا..." />
 * <button id="activateBtn">تفعيل</button>
 */
export function wireRedeemButton({
  inputId = 'codeInput',
  buttonId = 'activateBtn',
  onStatus = (msg) => console.log(msg),
} = {}) {
  const input = document.getElementById(inputId);
  const button = document.getElementById(buttonId);

  if (!input || !button) {
    console.warn('لم يتم العثور على عناصر الإدخال/الزر بالـ id المحدد');
    return;
  }

  button.addEventListener('click', async () => {
    const result = await redeemCustomCode(input.value);
    onStatus(result.message);
  });
}
