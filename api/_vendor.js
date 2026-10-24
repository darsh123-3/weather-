/* Server-only helper for the weather station vendor API (api.ascod.cn).
   Runs inside Vercel serverless functions (and the Vite dev server locally).
   The app ID / secret key are read from server environment variables and are
   NEVER sent to the browser. Files starting with "_" are not exposed as routes. */

const VENDOR_BASE =
  process.env.WEATHER_API_BASE || "https://api.ascod.cn/iotUser-api";
const TIMEOUT_MS = 15000;

let cachedToken = null; // reused while this server instance stays warm
let loginInFlight = null; // de-duplicates concurrent logins

function credentials() {
  const appid = process.env.WEATHER_APP_ID;
  const secretKey = process.env.WEATHER_SECRET_KEY;
  if (!appid || !secretKey) {
    throw new HttpError(
      500,
      "Server is missing WEATHER_APP_ID / WEATHER_SECRET_KEY environment variables.",
    );
  }
  return { appid, secretKey };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function vendorFetch(path, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${VENDOR_BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(502, `Station API returned an invalid response (HTTP ${res.status}).`);
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(
      e?.name === "AbortError" ? 504 : 502,
      e?.name === "AbortError" ? "Station API timed out." : "Couldn't reach the station API.",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function login() {
  if (!loginInFlight) {
    loginInFlight = (async () => {
      const data = await vendorFetch("/login/getToken", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials()),
      });
      if (data?.errcode !== 0 || !data?.token) {
        // Never echo the credentials; only the vendor's error text/code.
        throw new HttpError(502, `Station API login failed (${data?.errcode ?? "?"}).`);
      }
      cachedToken = data.token;
      return cachedToken;
    })().finally(() => {
      loginInFlight = null;
    });
  }
  return loginInFlight;
}

function looksExpired(result) {
  if (result?.errcode === 0) return false;
  const m = String(result?.errmsg || "").toLowerCase();
  return ["token", "credential", "凭证", "过期", "登陆失效", "登录失效"].some((w) =>
    m.includes(w),
  );
}

/* GET a vendor endpoint with a valid token, re-logging in once if it expired. */
export async function vendorGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${path}?${qs}` : path;
  const send = (token) => vendorFetch(url, { headers: { TOKEN: token } });

  let result = await send(cachedToken || (await login()));
  if (looksExpired(result)) {
    cachedToken = null;
    result = await send(await login());
  }
  if (result?.errcode !== 0) {
    throw new HttpError(502, result?.errmsg || "Station API request failed.");
  }
  return result;
}

/* Small helpers so handlers work both on Vercel and in the Vite dev middleware
   (plain Node req/res — no framework-specific helpers needed). */
export function queryOf(req) {
  return Object.fromEntries(new URL(req.url, "http://local").searchParams);
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export function handle(fn) {
  return async function handler(req, res) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return sendJson(res, 405, { errcode: 405, errmsg: "Method not allowed" });
    }
    try {
      sendJson(res, 200, await fn(queryOf(req)));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) console.error(e);
      sendJson(res, status, {
        errcode: status,
        errmsg: e instanceof HttpError ? e.message : "Internal server error",
      });
    }
  };
}
