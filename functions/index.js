const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const {
  apiVersionAllows,
  configuredDeploymentEnvironment,
  reportedDeploymentEnvironment,
  validatedSubscriptionStatusUrl,
} = require("./api-contract");
const { resolvesOnlyToPublicIps } = require("./network-policy");
const {
  TRUSTED_SOURCE_HOSTS,
  reachableTrustedSource,
} = require("./trusted-source");

if (!getApps().length) initializeApp();

// مرجع Secret Manager فقط؛ لا توجد قيمة سرية في المستودع أو إعداد staging.
const anthropicKey = defineSecret("ANTHROPIC_API_KEY");

const RATE_LIMIT_MAX_CALLS = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const SUBSCRIPTION_TIMEOUT_MS = 5_000;
const PROVIDER_TIMEOUT_MS = 20_000;
const FUNCTION_TIMEOUT_SECONDS = 40;

function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return defaultValue;
  return ["1", "true", "yes", "on", "enabled"].includes(raw.trim().toLowerCase());
}

// حد موزع (وليس ذاكرة عملية واحدة) حتى يبقى صحيحاً مع التوسع الأفقي.
async function checkRateLimit(uid, maxCalls = RATE_LIMIT_MAX_CALLS) {
  const firestore = getFirestore();
  const ref = firestore.collection("ai_rate_limits").doc(uid);
  const now = Date.now();
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const calls = (snapshot.exists && snapshot.data().calls) || [];
    const recent = calls.filter((timestamp) =>
      Number.isFinite(timestamp) && now - timestamp < RATE_LIMIT_WINDOW_MS
    );
    if (recent.length >= maxCalls) return false;
    recent.push(now);
    transaction.set(ref, { calls: recent }, { merge: true });
    return true;
  });
}

function prepareResponse(res, version) {
  res.set("Cache-Control", "no-store");
  res.set("X-Fatinah-API-Version", version);
  res.set("X-Fatinah-Environment", reportedDeploymentEnvironment());
}

async function generateQuestionsV1Handler(req, res) {
  prepareResponse(res, "1");
  if (!apiVersionAllows(req, "1")) {
    return res.status(400).json({
      error: "نسخة API لا تطابق اسم الدالة",
      code: "unsupported_api_version",
    });
  }
  if (req.method !== "POST") {
    res.set("Allow", "POST");
    return res.status(405).json({ error: "الطريقة غير مدعومة" });
  }
  if (!envFlag("FATINAH_V1_AI_GENERATION_ENABLED", false)) {
    return res.status(503).json({
      error: "التوليد القديم غير متاح مؤقتاً",
      code: "legacy_feature_disabled",
    });
  }

  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const uid = String(body.uid || "").trim();
    const idToken = String(body.idToken || "").trim();
    const topic = String(body.topic || "").trim().slice(0, 200);
    const trustedRound = body.trustedRound === true;
    const countNumber = Number.parseInt(body.count, 10);
    const safeCount = Math.min(Math.max(countNumber || 6, 4), 12);

    if (!uid || !idToken) {
      return res.status(401).json({ error: "رمز الدخول مطلوب" });
    }
    if (!topic) {
      return res.status(400).json({ error: "topic مطلوب" });
    }

    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(idToken, true);
    } catch (error) {
      logger.warn("v1 verifyIdToken failed");
      return res.status(401).json({
        error: "رمز الدخول غير صالح — سجّل دخولك مرة أخرى",
      });
    }
    if (decoded.uid !== uid) {
      return res.status(401).json({ error: "رمز الدخول غير مطابق للحساب" });
    }

    // trustedRound قادم من العميل ولا يمنح quota أعلى. نحد الطلب بعد auth
    // وقبل أي اتصال اشتراك أو AI حتى لا يستنزف مستخدم واحد الشبكة/التكلفة.
    const allowed = await checkRateLimit(uid, RATE_LIMIT_MAX_CALLS);
    if (!allowed) {
      return res.status(429).json({ error: "طلبات كثيرة جداً — حاول بعد قليل" });
    }

    let subscriptionActive = false;
    try {
      const statusUrl = validatedSubscriptionStatusUrl();
      if (!statusUrl) {
        return res.status(503).json({
          error: "إعداد خدمة الاشتراك غير مكتمل لهذه البيئة",
          code: "subscription_backend_misconfigured",
        });
      }
      const localEndpoint = configuredDeploymentEnvironment() === "local" &&
        statusUrl.protocol === "http:" &&
        ["127.0.0.1", "::1", "localhost"].includes(statusUrl.hostname);
      if (!localEndpoint && !await resolvesOnlyToPublicIps(statusUrl.hostname)) {
        return res.status(503).json({
          error: "تعذّر التحقق من وجهة خدمة الاشتراك",
          code: "subscription_backend_unsafe",
        });
      }
      statusUrl.searchParams.set("uid", uid);
      const response = await fetch(
        statusUrl.toString(),
        {
          headers: {
            Authorization: `Bearer ${idToken}`,
            "X-Fatinah-API-Version": "1",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(SUBSCRIPTION_TIMEOUT_MS),
        }
      );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        return res.status(502).json({
          error: "رفضت خدمة الاشتراك إعادة توجيه غير متوقعة",
          code: "subscription_redirect_rejected",
        });
      }
      if (response.ok) {
        const subscription = await response.json();
        subscriptionActive = subscription.active === true;
      }
    } catch (error) {
      logger.error("v1 subscription check failed");
    }
    if (!subscriptionActive) {
      return res.status(403).json({ error: "اشتراك فعّال مطلوب" });
    }

    const prompt = trustedRound
      ? `ولّد ${safeCount} أسئلة مسابقات بالعربية بلهجة خليجية بسيطة عن: "${topic}".\n` +
        `استخدم حقائق يمكن إسنادها فقط إلى مصدر من هذه الجهات: ${[...TRUSTED_SOURCE_HOSTS].join(", ")}.\n` +
        "لا تطرح سؤالاً دينياً أو سياسياً أو طبياً. أعد فقط JSON بالشكل: " +
        "[{\"q\":\"نص السؤال\",\"answer\":\"الإجابة الصحيحة\",\"source\":{\"title\":\"اسم المرجع\",\"url\":\"https://رابط-دقيق\"}}]."
      : `ولّد ${safeCount} أسئلة مسابقات بالعربية بلهجة خليجية بسيطة عن: "${topic}".\n` +
        "كل سؤال يجب أن يكون دقيقاً وصحيحاً واقعياً.\n" +
        "أعد فقط مصفوفة JSON بالشكل: [{\"q\":\"نص السؤال\",\"answer\":\"الإجابة الصحيحة\"}] بدون نص إضافي.";

    if (!await resolvesOnlyToPublicIps("api.anthropic.com")) {
      return res.status(502).json({ error: "تعذّر التحقق من وجهة مزود التوليد" });
    }
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey.value(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.FATINAH_V1_ANTHROPIC_MODEL || "claude-sonnet-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.error("v1 AI provider failed", { status: response.status });
      return res.status(502).json({ error: "تعذّر التوليد، حاول لاحقاً" });
    }

    const providerData = await response.json();
    const textBlock = (providerData.content || []).find(
      (block) => block.type === "text"
    );
    const clean = String((textBlock && textBlock.text) || "[]")
      .replace(/```json|```/g, "")
      .trim();
    const parsed = JSON.parse(clean);
    const candidates = Array.isArray(parsed)
      ? parsed.filter((question) => question && question.q && question.answer)
      : [];
    let questions = [];

    if (trustedRound) {
      const checked = await Promise.all(candidates.slice(0, safeCount).map(async (question) => {
        const url = await reachableTrustedSource(question.source && question.source.url);
        if (!url) return null;
        return {
          q: String(question.q).trim(),
          answer: String(question.answer).trim(),
          source: {
            title: String(
              (question.source && question.source.title) || "مرجع موثوق"
            ).trim().slice(0, 120),
            url,
          },
        };
      }));
      questions = checked.filter(Boolean);
      if (!questions.length) {
        return res.status(502).json({
          error: "تعذر التحقق من مصادر الأسئلة، حاول لاحقاً",
        });
      }
    } else {
      // لا نعيد أي حقول إضافية قد يضعها المزود في JSON؛ عقد 1.2 يحتاج q/answer فقط.
      questions = candidates.slice(0, safeCount).map((question) => ({
        q: String(question.q).trim().slice(0, 600),
        answer: String(question.answer).trim().slice(0, 400),
      })).filter((question) => question.q && question.answer);
    }

    return res.status(200).json({ questions, trustedSources: trustedRound });
  } catch (error) {
    logger.error("v1 generation failed");
    return res.status(500).json({ error: "صار خطأ غير متوقّع" });
  }
}

// الاسم القديم عقد v1 عام لتطبيق 1.2؛ لا يُحوّل إلى 410 خلال نافذة الدعم.
exports.generateQuestions = onRequest(
  { secrets: [anthropicKey], cors: true, timeoutSeconds: FUNCTION_TIMEOUT_SECONDS },
  generateQuestionsV1Handler
);

async function generateQuestionsV2Handler(req, res) {
  prepareResponse(res, "2");
  if (!apiVersionAllows(req, "2")) {
    return res.status(400).json({
      error: "نسخة API لا تطابق اسم الدالة",
      code: "unsupported_api_version",
    });
  }
  return res.status(410).json({
    error: "يستخدم API v2 بنك أسئلة مراجعاً مسبقاً.",
    code: "ai_generation_retired",
  });
}

// تطبيق 1.3 يستخدم بنك الأسئلة، لذلك اسم v2 منفصل ولا يغيّر سلوك v1.
exports.generateQuestionsV2 = onRequest(
  { cors: true, timeoutSeconds: 10 },
  generateQuestionsV2Handler
);
