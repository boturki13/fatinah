const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();

// السرّ محفوظ في Secret Manager، تم ربطه بـ:
// firebase functions:secrets:set ANTHROPIC_API_KEY
const anthropicKey = defineSecret("ANTHROPIC_API_KEY");

// نفس نقطة النهاية التي يثق بها التطبيق نفسه لحالة الاشتراك — قاعدة بيانات
// الاشتراكات (SQLite) تعيش فقط على خادم server.py، فلا نكرّر منطق التحقق
// بجافاسكريبت هنا (سينحرف عن الأصل بمرور الوقت)، بل نستدعيه مباشرة
const SUBSCRIPTION_STATUS_URL = "https://ata20.com/api/subscription/status";

const RATE_LIMIT_MAX_CALLS = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 دقائق لكل مستخدم

// لا نقبل رابطاً يختاره النموذج عشوائياً. هذه الجهات فقط تُعرض كمراجع
// للأسئلة المولّدة؛ وهي جهات رسمية أو مراجع عالمية معروفة. التحقق من
// الوصول للرابط أدناه يمنع إرجاع رابط وهمي أو نطاق مقلّد.
const TRUSTED_SOURCE_HOSTS = new Set([
  'nasa.gov', 'who.int', 'un.org', 'unesco.org', 'worldbank.org',
  'fifa.com', 'uefa.com', 'olympics.com', 'britannica.com',
  'nationalgeographic.com', 'loc.gov', 'smithsonianmag.com', 'noaa.gov',
]);

function trustedSourceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const allowed = [...TRUSTED_SOURCE_HOSTS].some(
      (domain) => host === domain || host.endsWith(`.${domain}`)
    );
    return allowed ? url.toString() : null;
  } catch (_) {
    return null;
  }
}

async function reachableTrustedSource(value) {
  const url = trustedSourceUrl(value);
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    let response = await fetch(url, {
      method: 'HEAD', redirect: 'follow', signal: controller.signal,
      headers: { 'User-Agent': 'FatinahQuestionVerifier/1.0' },
    });
    // بعض المواقع الموثوقة لا تدعم HEAD، لذا نتحقق بطلب خفيف بدلاً من رفضها.
    if (response.status === 405 || response.status === 403) {
      response = await fetch(url, {
        method: 'GET', redirect: 'follow', signal: controller.signal,
        headers: { 'User-Agent': 'FatinahQuestionVerifier/1.0', Range: 'bytes=0-1024' },
      });
    }
    // لا نتابع إعادة توجيه إلى نطاق آخر؛ الرابط النهائي يجب أن يبقى موثوقاً.
    const finalUrl = trustedSourceUrl(response.url);
    return response.ok && finalUrl ? finalUrl : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Cloud Functions بلا حالة مشتركة بين الاستدعاءات (قد تعمل على أي عدد نسخ)،
// فحد الاستخدام في الذاكرة (كما بـserver.py) غير موثوق هنا — نستخدم Firestore
// مع transaction لضمان عدّ صحيح حتى مع طلبات متزامنة
async function checkRateLimit(uid, maxCalls = RATE_LIMIT_MAX_CALLS) {
  const db = admin.firestore();
  const ref = db.collection("ai_rate_limits").doc(uid);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const calls = (snap.exists && snap.data().calls) || [];
    const recent = calls.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= maxCalls) return false;
    recent.push(now);
    tx.set(ref, { calls: recent }, { merge: true });
    return true;
  });
}

// دالة واحدة تخدم الاستخدامين: الأسئلة العائلية (من اللاعب) وتوسيع البنك (منك أنت)
exports.generateQuestions = onRequest(
  { secrets: [anthropicKey], cors: true, timeoutSeconds: 30 },
  async (req, res) => {
    try {
      const { topic, count, uid, idToken, trustedRound = false } = req.body || {};

      // 1) تحقّق حقيقي من هوية Firebase — كانت الدالة تتجاهل uid/idToken
      // المُرسَلين تماماً، فأي شخص (بلا تطبيق وبلا حساب) يقدر يستدعيها
      // مباشرة وينفق فاتورة Anthropic بلا حد (App Store / أمان P0-001)
      if (!uid || !idToken) {
        return res.status(401).json({ error: "رمز الدخول مطلوب" });
      }
      let decoded;
      try {
        decoded = await admin.auth().verifyIdToken(idToken);
      } catch (e) {
        logger.warn("verifyIdToken failed:", e.message);
        return res.status(401).json({ error: "رمز الدخول غير صالح — سجّل دخولك مرة أخرى" });
      }
      if (decoded.uid !== uid) {
        return res.status(401).json({ error: "رمز الدخول غير مطابق للحساب" });
      }

      // 2) فحص اشتراك فعلي — كانت الدالة تولّد الأسئلة لأي أحد بلا فحص
      // اشتراك إطلاقاً، فتُسقِط بوابة الدفع بالكامل على iOS
      let subActive = false;
      try {
        const subRes = await fetch(
          `${SUBSCRIPTION_STATUS_URL}?uid=${encodeURIComponent(uid)}`,
          { headers: { Authorization: `Bearer ${idToken}` } }
        );
        if (subRes.ok) {
          const subData = await subRes.json();
          subActive = subData.active === true;
        }
      } catch (e) {
        logger.error("subscription check failed:", e.message);
      }
      if (!subActive) {
        return res.status(403).json({ error: "اشتراك فعّال مطلوب" });
      }

      // 3) حد استخدام لكل مستخدم — بلا هذا يقدر مشترك واحد يستنزف تكلفة
      // Anthropic API بسكربتة طلبات متكررة
      // الجولة قد تضم حتى 10 فئات، وكل فئة تطلب دفعة واحدة من 6 أسئلة.
      // الحد الأعلى يبقى محدوداً للمشترك، لكنه لا يمنع جولة كاملة بسبب حد
      // التوليد العائلي الأصغر.
      const allowed = await checkRateLimit(uid, trustedRound ? 30 : RATE_LIMIT_MAX_CALLS);
      if (!allowed) {
        return res.status(429).json({ error: "طلبات كثيرة جداً — حاول بعد قليل" });
      }

      if (!topic || !count) {
        return res.status(400).json({ error: "الرجاء إرسال topic وcount" });
      }
      const safeTopic = String(topic).trim().slice(0, 200);
      if (!safeTopic) {
        return res.status(400).json({ error: "topic مطلوب" });
      }
      const safeCount = Math.min(Math.max(parseInt(count, 10) || 6, 4), 12);

      const prompt = trustedRound
        ? `ولّد ${safeCount} أسئلة مسابقات بالعربية بلهجة خليجية بسيطة عن: "${safeTopic}".\n` +
          `استخدم حقائق يمكن إسنادها فقط إلى مصدر من هذه الجهات: ${[...TRUSTED_SOURCE_HOSTS].join(', ')}.\n` +
          `لا تطرح سؤالاً دينياً أو سياسياً أو طبياً. أعد فقط JSON بالشكل: ` +
          `[{"q":"نص السؤال","answer":"الإجابة الصحيحة","source":{"title":"اسم المرجع","url":"https://رابط-دقيق"}}]. ` +
          `يجب أن يكون الرابط صفحة HTTPS دقيقة تدعم حقيقة السؤال، بلا أي markdown أو نص إضافي.`
        : `ولّد ${safeCount} أسئلة مسابقات بالعربية بلهجة خليجية بسيطة عن: "${safeTopic}".\n` +
          `كل سؤال يجب أن يكون دقيقاً وصحيحاً واقعياً.\n` +
          `أعد فقط مصفوفة JSON بالشكل: [{"q":"نص السؤال","answer":"الإجابة الصحيحة"}] بدون أي نص إضافي أو علامات markdown.`;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey.value(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        logger.error("خطأ من Anthropic API:", errText);
        return res.status(502).json({ error: "تعذّر التوليد، حاول لاحقاً" });
      }

      const data = await response.json();
      const textBlock = (data.content || []).find((b) => b.type === "text");
      const raw = (textBlock && textBlock.text) || "[]";
      const clean = raw.replace(/```json|```/g, "").trim();
      const questions = JSON.parse(clean);

      // تحقّق أساسي من شكل البيانات قبل الإرجاع
      let valid = Array.isArray(questions)
        ? questions.filter((q) => q && q.q && q.answer)
        : [];

      if (trustedRound) {
        const withSources = await Promise.all(valid.map(async (question) => {
          const url = await reachableTrustedSource(question.source && question.source.url);
          if (!url) return null;
          return {
            q: String(question.q).trim(),
            answer: String(question.answer).trim(),
            source: { title: String(question.source.title || 'مرجع موثوق').trim().slice(0, 120), url },
          };
        }));
        valid = withSources.filter(Boolean);
        if (!valid.length) {
          return res.status(502).json({ error: 'تعذر التحقق من مصادر الأسئلة، حاول لاحقاً' });
        }
      }

      return res.status(200).json({ questions: valid, trustedSources: trustedRound });
    } catch (err) {
      logger.error("خطأ داخلي:", err);
      return res.status(500).json({ error: "صار خطأ غير متوقّع" });
    }
  }
);
