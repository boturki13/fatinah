"use strict";

const {
  apiVersionAllows,
  reportedDeploymentEnvironment,
} = require("./api-contract");

function prepareResponse(res, version) {
  res.set("Cache-Control", "no-store");
  res.set("X-Fatinah-API-Version", version);
  res.set("X-Fatinah-Environment", reportedDeploymentEnvironment());
}

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

module.exports = {
  generateQuestionsV2Handler,
  prepareResponse,
};
