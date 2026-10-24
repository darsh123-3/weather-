
import axios from "axios";

const api = axios.create({
  baseURL: "/api",
  timeout: 15000,
});

const TOKEN_KEY = "weather_station_token";

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function doLogin() {
  const APP_ID = import.meta.env.VITE_WEATHER_APP_ID;
  const SECRET_KEY = import.meta.env.VITE_WEATHER_SECRET_KEY;

  if (!APP_ID || !SECRET_KEY) {
    throw new Error("Missing credentials. Check your .env.local file.");
  }

  const { data } = await api.post(
    "/login/getToken",
    {
      appid: APP_ID,
      secretKey: SECRET_KEY,
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  if (data.errcode !== 0 || !data.token) {
    throw new Error(
      `Token generation failed: ${data.errmsg} (${data.errcode})`
    );
  }

  localStorage.setItem(TOKEN_KEY, data.token);
  return data.token;
}

/* Several windows are fetched in parallel; they must share ONE login,
   otherwise each request would ask for its own token at the same time. */
let loginInFlight = null;
export function login() {
  if (!loginInFlight) {
    loginInFlight = doLogin().finally(() => {
      loginInFlight = null;
    });
  }
  return loginInFlight;
}

async function request(url, params = {}, signal) {
  let token = localStorage.getItem(TOKEN_KEY);

  if (!token) {
    token = await login();
  }

  const send = (credential) =>
    api.get(url, {
      params,
      signal,
      headers: {
        TOKEN: credential,
      },
    });

  let response = await send(token);
  let result = response.data;

  const message = String(result.errmsg || "").toLowerCase();

  const tokenExpired =
    result.errcode !== 0 &&
    (
      message.includes("token") ||
      message.includes("credential") ||
      message.includes("凭证") ||
      message.includes("过期") ||
      message.includes("登陆失效") ||
      message.includes("登录失效")
    );

  if (tokenExpired) {
    // Another parallel request may already have renewed the token.
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored && stored !== token) {
      token = stored;
    } else {
      clearToken();
      token = await login();
    }
    response = await send(token);
    result = response.data;
  }

  if (result.errcode !== 0) {
    throw new Error(result.errmsg || "API request failed");
  }

  return result;
}

export async function getGateways() {
  const result = await request("/v1/gateway/getGatewayOption");

  return Array.isArray(result.data) ? result.data : [];
}

export async function getSensorData(deviceNo, startDate, endDate) {
  if (!deviceNo) {
    throw new Error("Please select a gateway.");
  }

  if (!startDate || !endDate) {
    throw new Error("Please select both start and end date/time.");
  }

  if (new Date(startDate.replace(" ", "T")) > new Date(endDate.replace(" ", "T"))) {
    throw new Error("Start date/time must be before end date/time.");
  }

  const result = await request(
    "/v1/gateway/getMeteorologicalData",
    {
      no: deviceNo,
      startDate,
      endDate,
    }
  );

  return Array.isArray(result.list) ? result.list : [];
}

/* ------------------------------------------------------------------ */
/*  Full history for a date range                                      */
/* ------------------------------------------------------------------ */

/* IMPORTANT — how the vendor API behaves (seen in real responses):
   getMeteorologicalData does NOT return every reading. It returns only every
   2nd one (1st, 3rd, 5th …), for short and long ranges alike. The FIRST
   (earliest) reading of the requested window is always returned.

   So the app fills the gaps: after each response it asks again for the time
   AFTER every reading it received (up to the next received reading, and up to
   the end of the window). Each such request returns the earliest reading
   hidden in that gap, if there is one. A gap that comes back empty truly holds
   nothing. Repeating this until every gap is empty finds ALL readings, however
   the API thins its answers.

   Past time spans that are proven complete are remembered for this session,
   so live updates and re-selected ranges don't fetch them again. */

const DAY_MS = 24 * 3600000; // the range is first split into 1-day windows
const MAX_PARALLEL = 6; // requests in flight at once
const MAX_REQUESTS_PER_LOAD = 3000; // safety stop for extremely large ranges
const SETTLE_MS = 30 * 60000; // readings can arrive late; recent time is always re-checked
const CHINA_OFFSET_MS = 8 * 3600000; // API works in China time (UTC+08:00)

const p2 = (n) => String(n).padStart(2, "0");
function toChinaWallTime(ms) {
  const c = new Date(ms + CHINA_OFFSET_MS);
  return `${c.getUTCFullYear()}-${p2(c.getUTCMonth() + 1)}-${p2(c.getUTCDate())} ${p2(c.getUTCHours())}:${p2(c.getUTCMinutes())}:${p2(c.getUTCSeconds())}`;
}
const floorSec = (ms) => Math.floor(ms / 1000) * 1000;

function recordDate(r) {
  return r?.gatherDate || r?.collectDate || r?.createTime || r?.time || "";
}
/** Same station + same time = same reading. */
export function readingKey(r) {
  return `${r?.no ?? ""}|${recordDate(r)}`;
}
/** Reading time as epoch ms (API times without an offset are China time). */
function recordTime(r) {
  const raw = String(recordDate(r)).trim();
  if (/^\d{10}(\d{3})?$/.test(raw)) return Number(raw) * (raw.length === 10 ? 1000 : 1);
  const text = raw
    .replace(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/, (_, y, m, d) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`)
    .replace(" ", "T");
  const t = new Date(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}+08:00`).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/* Limits how many requests run at the same time. */
let active = 0;
const queue = [];
async function limited(task) {
  if (active >= MAX_PARALLEL) await new Promise((resolve) => queue.push(resolve));
  active++;
  try {
    return await task();
  } finally {
    active--;
    queue.shift()?.();
  }
}

async function fetchWindow(deviceNo, startMs, endMs, signal) {
  const params = {
    no: deviceNo,
    startDate: toChinaWallTime(startMs),
    endDate: toChinaWallTime(endMs),
  };
  return limited(async () => {
    if (signal?.aborted) throw new axios.CanceledError();
    try {
      const result = await request("/v1/gateway/getMeteorologicalData", params, signal);
      return Array.isArray(result.list) ? result.list : [];
    } catch (err) {
      if (signal?.aborted) throw err;
      // One retry: field / mobile connections drop requests now and then.
      const result = await request("/v1/gateway/getMeteorologicalData", params, signal);
      return Array.isArray(result.list) ? result.list : [];
    }
  });
}

/* Per-station session cache: every reading found + time spans proven complete. */
const stations = new Map();
function stationCache(deviceNo) {
  const key = String(deviceNo);
  if (!stations.has(key)) stations.set(key, { readings: new Map(), complete: [] });
  return stations.get(key);
}
function addSpan(spans, a, b) {
  const all = [...spans, [a, b]].sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [s, e] of all) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1000) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
/** Parts of [a, b] that are not yet proven complete. */
function uncovered(spans, a, b) {
  const out = [];
  let cur = a;
  for (const [s, e] of spans) {
    if (e < cur) continue;
    if (s > b) break;
    if (s > cur) out.push([cur, Math.min(s - 1000, b)]);
    cur = Math.max(cur, e + 1000);
    if (cur > b) break;
  }
  if (cur <= b) out.push([cur, b]);
  return out.filter(([x, y]) => y >= x);
}

/**
 * Every reading of a station between two instants (epoch ms), as raw API records.
 * onProgress(requestsDone, readingsFound) lets the UI show progress.
 */
export async function getAllReadings(deviceNo, startMs, endMs, { signal, onProgress } = {}) {
  if (!deviceNo) throw new Error("Please select a gateway.");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs))
    throw new Error("Please select both start and end date/time.");
  if (startMs > endMs) throw new Error("Start date/time must be before end date/time.");

  const a0 = floorSec(startMs);
  const b0 = floorSec(endMs);
  const cache = stationCache(deviceNo);
  const settledBefore = Date.now() - SETTLE_MS;
  let requests = 0;
  const inRange = (t) => t >= a0 && t <= b0;
  const countFound = () =>
    [...cache.readings.values()].filter((r) => inRange(recordTime(r))).length;

  const markComplete = (a, b) => {
    const end = Math.min(b, settledBefore);
    if (end >= a) cache.complete = addSpan(cache.complete, a, end);
  };

  // Finds every reading in [a, b] (both inclusive, whole seconds).
  async function fill(a, b) {
    if (b < a) return;
    if (++requests > MAX_REQUESTS_PER_LOAD) {
      throw new Error(
        "This date range holds too many readings to load at once. Please choose a shorter range.",
      );
    }
    const list = await fetchWindow(deviceNo, a, b, signal);
    const times = [];
    list.forEach((r) => {
      const t = recordTime(r);
      if (!r || !Number.isFinite(t) || t < a || t > b) return;
      cache.readings.set(readingKey(r), r);
      times.push(t);
    });
    onProgress?.(requests, countFound());
    if (!times.length) return markComplete(a, b); // empty answer = nothing there

    // Nothing hides before the first reading (the API always returns the earliest one).
    // Readings can hide AFTER each returned reading → ask for each of those gaps.
    const sorted = [...new Set(times)].sort((x, y) => x - y);
    const gaps = sorted.map((t, i) => [t + 1000, i + 1 < sorted.length ? sorted[i + 1] - 1000 : b]);
    await Promise.all(gaps.map(([x, y]) => fill(x, y)));
    markComplete(a, b);
  }

  const todo = [];
  for (const [x, y] of uncovered(cache.complete, a0, b0)) {
    for (let a = x; a <= y; a += DAY_MS) todo.push([a, Math.min(a + DAY_MS - 1000, y)]);
  }
  onProgress?.(0, countFound());
  await Promise.all(todo.reverse().map(([a, b]) => fill(a, b))); // newest day first

  return [...cache.readings.values()].filter((r) => inRange(recordTime(r)));
}
