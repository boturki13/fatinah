/**
 * apple-redeem.js
 * ----------------
 * يربط خانة إدخال كود العرض (Offer Code) اللي صممتها في تطبيقك بواجهة أبل
 * الرسمية لاسترداد الأكواد، وبالباك إند (apple-redeem-backend) اللي يسجل
 * محاولات الاسترداد ويتحقق من إشعارات أبل عشان تعرف متى صار الاشتراك فعّال.
 *
 * التحقق من صحة الكود وتفعيل العرض (الشهر المجاني) يصير بالكامل عند أبل.
 * هذا الملف "يمرر" الكود لصفحة أبل الرسمية عن طريق رابط الاسترداد، ويسجل
 * محاولة الاسترداد في الباك إند تبعك قبل التحويل، عشان لما توصل إشعار من
 * أبل لاحقًا يقدر الباك إند يخمّن مين المستخدم اللي فعّل (راجع تعليق
 * "قيود معروفة" تحت).
 *
 * يحتاج تثبيت: @capacitor/browser
 *   npm install @capacitor/browser
 *   npx cap sync ios
 */

import { Browser } from '@capacitor/browser';

// عدّل هذا الرقم فقط: هذا هو "Apple ID" الرقمي لتطبيقك
// (تلقاه في App Store Connect → App Information → Apple ID)
// وهو رقم مختلف تمامًا عن Bundle ID.
const APPLE_APP_ID = 'REPLACE_WITH_YOUR_NUMERIC_APP_ID';

// رابط الباك إند (apple-redeem-backend) بعد رفعه على Replit، مثال:
// https://your-repl-name.your-username.repl.co
const BACKEND_URL = 'REPLACE_WITH_YOUR_BACKEND_URL';

/**
 * يحاول يجيب معرّف المستخدم الحالي من @capacitor-firebase/authentication
 * (نفس الحزمة اللي تستخدمها لتسجيل الدخول بحسب وصفك). إذا ما كان مسجل
 * دخول أو الحزمة مو محمّلة، يرجع null والدالة تكمل بدون userId.
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
 * يسجل محاولة الاسترداد في الباك إند (قبل ما نحوّل العميل لأبل)، عشان
 * يكون عندك سجل بمين حاول يستخدم أي كود ومتى.
 */
async function logAttempt(code, userId) {
  if (!BACKEND_URL || BACKEND_URL.startsWith('REPLACE_')) return; // الباك إند مو مركّب بعد

  try {
    await fetch(`${BACKEND_URL}/api/redeem-attempt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, userId }),
    });
  } catch (err) {
    // ما نوقف عملية الاسترداد إذا فشل تسجيل المحاولة (مثلًا الشبكة بطيئة)
    console.warn('تعذر تسجيل محاولة الاسترداد في الباك إند:', err);
  }
}

/**
 * يفتح صفحة استرداد الكود الرسمية من أبل بنفس الكود اللي كتبه العميل.
 * @param {string} code - الكود اللي كتبه العميل في الخانة
 */
export async function redeemAppleCode(code) {
  const trimmed = (code || '').trim();

  if (!trimmed) {
    return { ok: false, message: 'الرجاء إدخال الكود' };
  }

  const userId = await getCurrentUserId();
  await logAttempt(trimmed, userId);

  const url =
    `https://apps.apple.com/redeem?ctx=offercodes` +
    `&id=${APPLE_APP_ID}` +
    `&code=${encodeURIComponent(trimmed)}`;

  // مهم: نفتحه عبر Browser.open (طبقة النظام) مو window.location أو iframe
  // داخل الـ WebView، عشان iOS يتعامل معه كـ Universal Link ويحوّل العميل
  // مباشرة لتطبيق App Store لإتمام التفعيل.
  await Browser.open({ url, presentationStyle: 'popover' });

  return { ok: true, message: 'جاري تحويلك لإتمام التفعيل عبر App Store...' };
}

/**
 * يسأل الباك إند: هل اشتراك هذا المستخدم فعّال الآن؟ استدعها لما يرجع
 * العميل لتطبيقك (مثلًا عند فتح التطبيق من جديد) عشان تفتح له الميزات.
 */
export async function checkSubscriptionStatus(userId) {
  if (!BACKEND_URL || BACKEND_URL.startsWith('REPLACE_')) {
    return { ok: false, active: false, message: 'الباك إند مو مركّب بعد' };
  }

  const uid = userId || (await getCurrentUserId());
  if (!uid) return { ok: false, active: false, message: 'لا يوجد مستخدم مسجل دخول' };

  try {
    const res = await fetch(`${BACKEND_URL}/api/subscription-status?userId=${encodeURIComponent(uid)}`);
    return await res.json();
  } catch (err) {
    console.warn('تعذر التحقق من حالة الاشتراك:', err);
    return { ok: false, active: false, message: 'تعذر الاتصال بالباك إند' };
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
    const result = await redeemAppleCode(input.value);
    onStatus(result.message);
  });
}

/**
 * قيود معروفة (مهم تعرفها):
 * أبل ما ترسل لك أبدًا نص الكود اللي انرد استخدامه في إشعارات السيرفر،
 * فقط اسم دفعة العروض (offerIdentifier، مثل "MON1") ومعرّفات المعاملة.
 * يعني ربط "هذا الكود بالضبط" بـ"هذا المستخدم بالضبط" ما يصير مضمون
 * 100% إلا لو استخدمت StoreKit الأصلي من داخل التطبيق (presentCodeRedemptionSheet
 * مع appAccountToken) بدل رابط الاسترداد الخارجي. الباك إند حاليًا يخمّن
 * الربط عن طريق "آخر محاولة استرداد معلّقة" خلال ٣٠ دقيقة، وهذا يكفي
 * عمليًا لتطبيق بحجم ٥٠٠ كود توزعها بنفسك، لكنه مو دقيق ١٠٠٪ إذا صار
 * أكثر من عميل يفعّلون كودهم بنفس اللحظة تقريبًا.
 */
