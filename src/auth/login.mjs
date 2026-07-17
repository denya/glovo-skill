import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decodeJwt, saveSession, tokenStatus } from "./store.mjs";

const START_URL = process.env.GLOVO_LOGIN_URL || "https://glovoapp.com/en/login?returnPath=%2Fen%2Fprofile";

function normalizeCredentials(body) {
  const c = body?.access?.accessToken ? body.access : body;
  if (!c?.accessToken) return null;
  return {
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    expiresIn: c.expiresIn,
    scope: c.scope ?? null,
    tokenType: c.tokenType ?? "bearer",
    createdAt: Date.now(),
  };
}

function locationFromHeaders(headers) {
  const h = {};
  for (const [key, value] of Object.entries(headers || {})) h[key.toLowerCase()] = value;
  if (!h["glovo-location-country-code"] && !h["glovo-location-city-code"]) return null;
  return {
    countryCode: h["glovo-location-country-code"],
    cityCode: h["glovo-location-city-code"],
    latitude: h["glovo-delivery-location-latitude"],
    longitude: h["glovo-delivery-location-longitude"],
    accuracy: h["glovo-delivery-location-accuracy"],
    languageCode: h["glovo-language-code"],
    appVersion: h["glovo-app-version"],
    clientInfo: h["glovo-client-info"],
    deviceUrn: h["glovo-device-urn"],
    perseusClientId: h["glovo-perseus-client-id"],
    perseusSessionId: h["glovo-perseus-session-id"],
    perseusSessionTimestamp: h["glovo-perseus-session-timestamp"],
    perseusConsent: h["glovo-perseus-consent"],
  };
}

function mergeLocation(current, next) {
  if (!next) return current;
  return Object.fromEntries(Object.entries({ ...(current || {}), ...next }).filter(([, value]) => value != null && value !== ""));
}

export async function runLogin(sessionPath, { timeoutMs = 5 * 60_000 } = {}) {
  const { chromium } = await import("playwright-core");
  mkdirSync(dirname(sessionPath), { recursive: true });
  const channel = process.env.GLOVO_BROWSER_CHANNEL || "chrome";
  let browser;
  try {
    browser = await chromium.launch({ headless: false, channel });
  } catch (e) {
    throw new Error(`Couldn't open ${channel}. Make sure Google Chrome is installed. (${e.message.split("\n")[0]})`);
  }

  try {
    const context = await browser.newContext();
    let credentials = null;
    let customer = null;
    let location = null;

    context.on("request", (req) => {
      if (!req.url().startsWith("https://api.glovoapp.com/")) return;
      location = mergeLocation(location, locationFromHeaders(req.headers()));
    });

    context.on("response", async (res) => {
      const url = res.url();
      if (url.includes("/oauth/token") || url.includes("/oauth/refresh") || url.includes("/oauth/2fa/")) {
        try {
          const body = await res.json();
          const c = normalizeCredentials(body);
          if (c?.accessToken) credentials = c;
        } catch {
          // Ignore non-JSON or failed auth responses.
        }
      }
      if (url.includes("/v3/me")) {
        try {
          customer = await res.json();
        } catch {
          // Ignore partial profile reads.
        }
      }
    });

    const page = await context.newPage();
    await page.goto(START_URL, { waitUntil: "domcontentloaded" });
    const start = Date.now();
    while (!credentials && Date.now() - start < timeoutMs) {
      await page.waitForTimeout(1000);
    }
    if (!credentials) throw new Error("No Glovo login token detected in time. Run glovo_login again and complete sign-in in the browser.");

    await page.goto("https://glovoapp.com/en/profile", { waitUntil: "domcontentloaded" }).catch(() => {});
    const settleStart = Date.now();
    while (!customer && Date.now() - settleStart < 15_000) await page.waitForTimeout(500);

    const decoded = decodeJwt(credentials.accessToken);
    const session = {
      ...credentials,
      exp: decoded?.exp,
      customerId: customer?.id ?? decoded?.customerId ?? decoded?.customer_id ?? decoded?.sub ?? null,
      customer: customer ? { id: customer.id, name: customer.name, email: customer.email } : null,
      deviceUrn: location?.deviceUrn,
      perseusClientId: location?.perseusClientId,
      perseusSessionId: location?.perseusSessionId,
      perseusSessionTimestamp: location?.perseusSessionTimestamp,
      location,
    };
    saveSession(sessionPath, session);
    return {
      customerId: session.customerId,
      signedIn: true,
      daysLeft: tokenStatus(session).daysLeft,
      hasLocation: Boolean(location?.cityCode || location?.latitude),
    };
  } finally {
    await browser.close();
  }
}
