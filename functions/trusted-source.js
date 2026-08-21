"use strict";

const { resolvesOnlyToPublicIps } = require("./network-policy");

const SOURCE_VALIDATION_TIMEOUT_MS = 5_000;
const MAX_SOURCE_REDIRECTS = 3;
const TRUSTED_SOURCE_HOSTS = new Set([
  "nasa.gov", "who.int", "un.org", "unesco.org", "worldbank.org",
  "fifa.com", "uefa.com", "olympics.com", "britannica.com",
  "nationalgeographic.com", "loc.gov", "smithsonianmag.com", "noaa.gov",
]);

function trustedSourceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || (url.port && url.port !== "443")) return null;
    if (url.username || url.password || url.hash) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    const allowed = [...TRUSTED_SOURCE_HOSTS].some(
      (domain) => host === domain || host.endsWith(`.${domain}`)
    );
    return allowed ? url : null;
  } catch (_) {
    return null;
  }
}

function redirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

async function fetchTrustedWithoutRedirects(value, {
  method,
  fetchImpl,
  lookupImpl,
  signal,
  range = false,
}) {
  let current = trustedSourceUrl(value);
  if (!current) return null;
  for (let redirectCount = 0; redirectCount <= MAX_SOURCE_REDIRECTS; redirectCount += 1) {
    if (signal.aborted) return null;
    if (!await resolvesOnlyToPublicIps(
      current.hostname, { lookupImpl, timeoutMs: 1_000 }
    )) return null;
    const response = await fetchImpl(current.toString(), {
      method,
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": "FatinahQuestionVerifier/1.0",
        ...(range ? { Range: "bytes=0-1024" } : {}),
      },
    });
    if (!redirectStatus(response.status)) {
      return { response, url: current.toString() };
    }
    if (redirectCount === MAX_SOURCE_REDIRECTS) return null;
    const location = response.headers && response.headers.get("location");
    if (!location) return null;
    current = trustedSourceUrl(new URL(location, current).toString());
    if (!current) return null;
  }
  return null;
}

async function reachableTrustedSource(value, {
  fetchImpl = globalThis.fetch,
  lookupImpl,
  timeoutMs = SOURCE_VALIDATION_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let result = await fetchTrustedWithoutRedirects(value, {
      method: "HEAD", fetchImpl, lookupImpl, signal: controller.signal,
    });
    if (result && (result.response.status === 405 || result.response.status === 403)) {
      result = await fetchTrustedWithoutRedirects(result.url, {
        method: "GET", fetchImpl, lookupImpl,
        signal: controller.signal, range: true,
      });
    }
    return result && result.response.ok ? result.url : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  MAX_SOURCE_REDIRECTS,
  SOURCE_VALIDATION_TIMEOUT_MS,
  TRUSTED_SOURCE_HOSTS,
  reachableTrustedSource,
  trustedSourceUrl,
};
