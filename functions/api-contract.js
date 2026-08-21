"use strict";

const DEFAULT_SUBSCRIPTION_STATUS_URL =
  "https://ata20.com/api/subscription/status";
const DEPLOYMENT_ENVIRONMENTS = new Set(["local", "staging", "production"]);
const PRODUCTION_SUBSCRIPTION_HOSTS = new Set(["ata20.com"]);
const SUBSCRIPTION_ALLOWED_HOSTS_ENV =
  "FATINAH_V1_SUBSCRIPTION_ALLOWED_HOSTS";

function configuredDeploymentEnvironment() {
  const raw = (process.env.FATINAH_ENVIRONMENT || "").trim().toLowerCase();
  if (!raw) return null;
  const aliases = {
    dev: "local", development: "local", stage: "staging", prod: "production",
  };
  const value = aliases[raw] || raw;
  return DEPLOYMENT_ENVIRONMENTS.has(value) ? value : null;
}

function reportedDeploymentEnvironment() {
  const raw = (process.env.FATINAH_ENVIRONMENT || "").trim();
  if (!raw) return "unconfigured";
  return configuredDeploymentEnvironment() || "invalid";
}

function subscriptionStatusUrl() {
  const configured = (process.env.FATINAH_V1_SUBSCRIPTION_STATUS_URL || "").trim();
  if (configured) return configured;
  return configuredDeploymentEnvironment() === "production"
    ? DEFAULT_SUBSCRIPTION_STATUS_URL
    : "";
}

function configuredHostAllowlist(name) {
  return new Set((process.env[name] || "").split(",").map((value) =>
    value.trim().toLowerCase().replace(/\.$/, "")
  ).filter((value) => /^[a-z0-9.-]{1,253}$/.test(value)));
}

function subscriptionAllowedHosts() {
  const environment = configuredDeploymentEnvironment();
  if (environment === "production") return new Set(PRODUCTION_SUBSCRIPTION_HOSTS);
  const configured = configuredHostAllowlist(SUBSCRIPTION_ALLOWED_HOSTS_ENV);
  if (environment === "staging") return configured;
  if (environment === "local") {
    return new Set([...configured, "127.0.0.1", "::1", "localhost"]);
  }
  return new Set();
}

function validatedSubscriptionStatusUrl() {
  const raw = subscriptionStatusUrl();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.username || url.password || url.hash) return null;
    const environment = configuredDeploymentEnvironment();
    if (!subscriptionAllowedHosts().has(host)) return null;
    const localHttp = environment === "local" && url.protocol === "http:" &&
      ["127.0.0.1", "::1", "localhost"].includes(host);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    if (!localHttp && (url.protocol !== "https:" || port !== "443")) return null;
    if (environment === "production" &&
        (url.pathname !== "/api/subscription/status" || url.search)) return null;
    return url;
  } catch (_) {
    return null;
  }
}

function requestedApiVersion(req, endpointVersion) {
  const header = typeof req.get === "function"
    ? req.get("X-Fatinah-API-Version")
    : req.headers && req.headers["x-fatinah-api-version"];
  if (header === undefined || header === null || header === "") {
    return endpointVersion;
  }
  if (Array.isArray(header)) return null;
  let value = String(header).trim().toLowerCase();
  if (value.includes(",")) return null;
  if (value.startsWith("v")) value = value.slice(1);
  return value === "1" || value === "2" ? value : null;
}

function apiVersionAllows(req, endpointVersion) {
  return requestedApiVersion(req, endpointVersion) === endpointVersion;
}

module.exports = {
  apiVersionAllows,
  configuredDeploymentEnvironment,
  reportedDeploymentEnvironment,
  requestedApiVersion,
  subscriptionStatusUrl,
  subscriptionAllowedHosts,
  validatedSubscriptionStatusUrl,
};
