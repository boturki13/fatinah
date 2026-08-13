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

// Cloud Functions بلا حالة مشتركة بين الاستدعاءات (قد تعمل على أي عدد نسخ)،
// فحد الاستخدام في الذاكرة (كما بـserver.py) غير موثوق هنا — نستخدم Firestore
// مع transaction لضمان عدّ صحيح حتى مع طلبات متزامنة
async function checkRateLimit(uid) {
  const db = admin.firestore();
  const ref = db.collection("ai_rate_limits").doc(uid);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const calls = (snap.exists && snap.data().calls) || [];
    const recent = calls.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX_CALLS) return false;
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
      const { topic, count, uid, idToken } = req.body || {};

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
      const allowed = await checkRateLimit(uid);
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

      const prompt =
        `ولّد ${safeCount} أسئلة مسابقات بالعربية بلهجة خليجية بسيطة عن: "${safeTopic}".\n` +
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
      const valid = Array.isArray(questions)
        ? questions.filter((q) => q && q.q && q.answer)
        : [];

      return res.status(200).json({ questions: valid });
    } catch (err) {
      logger.error("خطأ داخلي:", err);
      return res.status(500).json({ error: "صار خطأ غير متوقّع" });
    }
  }
);
