const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

// السرّ محفوظ في Secret Manager، تم ربطه بـ:
// firebase functions:secrets:set ANTHROPIC_API_KEY
const anthropicKey = defineSecret("ANTHROPIC_API_KEY");

// دالة واحدة تخدم الاستخدامين: الأسئلة العائلية (من اللاعب) وتوسيع البنك (منك أنت)
exports.generateQuestions = onRequest(
  { secrets: [anthropicKey], cors: true, timeoutSeconds: 30 },
  async (req, res) => {
    try {
      const { topic, count } = req.body || {};
      if (!topic || !count) {
        return res.status(400).json({ error: "الرجاء إرسال topic وcount" });
      }
      const safeCount = Math.min(Math.max(parseInt(count, 10) || 6, 4), 12);

      const prompt =
        `ولّد ${safeCount} أسئلة مسابقات بالعربية بلهجة خليجية بسيطة عن: "${topic}".\n` +
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
