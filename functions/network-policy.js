"use strict";

const dns = require("node:dns").promises;
const net = require("node:net");

function privateOrNonGlobalIp(value) {
  const address = String(value || "").toLowerCase().split("%", 1)[0];
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a === 255
    );
  }
  if (family === 6) {
    if (address.startsWith("::ffff:")) {
      return privateOrNonGlobalIp(address.slice("::ffff:".length));
    }
    if (address === "::" || address === "::1") return true;
    const first = Number.parseInt(address.split(":", 1)[0] || "0", 16);
    // عناوين unicast العالمية فقط 2000::/3، مع استبعاد documentation.
    return first < 0x2000 || first > 0x3fff || address.startsWith("2001:db8:");
  }
  return true;
}

async function resolvesOnlyToPublicIps(hostname, {
  lookupImpl = dns.lookup,
  timeoutMs = 2_000,
} = {}) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (net.isIP(host)) return !privateOrNonGlobalIp(host);
  let timer;
  try {
    const addresses = await Promise.race([
      lookupImpl(host, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("dns_timeout")), timeoutMs);
      }),
    ]);
    return Array.isArray(addresses) && addresses.length > 0 &&
      addresses.every((entry) => entry && !privateOrNonGlobalIp(entry.address));
  } catch (_) {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  privateOrNonGlobalIp,
  resolvesOnlyToPublicIps,
};
