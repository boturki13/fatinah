const { onRequest } = require("firebase-functions/v2/https");

// تبقى الدالة بالاسم القديم مؤقتاً حتى تحصل الإصدارات السابقة على رد واضح
// بدلاً من خطأ شبكة. لا تُربط بأي مفتاح سري ولا تستدعي أي مزوّد ذكاء اصطناعي.
exports.generateQuestions = onRequest(
  { cors: true, timeoutSeconds: 10 },
  async (_req, res) => res.status(410).json({
    error: "تم إيقاف التوليد الآلي. تستخدم فطنة بنك أسئلة مراجعاً مسبقاً."
  })
);
