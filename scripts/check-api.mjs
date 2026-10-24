/* Cross-checks the vendor weather API directly (no browser, no app code).
   Usage, from the project folder:   node scripts/check-api.mjs [gatewayNo]
   Reads WEATHER_APP_ID / WEATHER_SECRET_KEY from .env.local. Prints NO secrets.

   For several windows ending now, it compares:
     direct  = one API call for the whole window
     chunked = the same window split into 1-hour calls, merged
   If "chunked" finds more readings than "direct", the API is dropping data for
   long ranges (which is what the app now works around). It also shows the newest
   timestamps and the gap between readings, so you can see the real upload rate. */
import { readFileSync } from "node:fs";

const BASE = process.env.WEATHER_API_BASE || "https://api.ascod.cn/iotUser-api";
const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*['"]?(.*?)['"]?\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const appid = env.WEATHER_APP_ID || env.VITE_WEATHER_APP_ID;
const secretKey = env.WEATHER_SECRET_KEY || env.VITE_WEATHER_SECRET_KEY;
if (!appid || !secretKey) {
  console.error("WEATHER_APP_ID / WEATHER_SECRET_KEY not found in .env.local");
  process.exit(1);
}

const pad = (n) => String(n).padStart(2, "0");
// China wall time (UTC+8), which the vendor API uses.
const china = (ms) => {
  const d = new Date(ms + 8 * 3600000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
const ist = (ms) => {
  const d = new Date(ms + 5.5 * 3600000);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
const dateOf = (r) => r?.gatherDate || r?.collectDate || r?.createTime || r?.time || "";

async function call(path, init) {
  const res = await fetch(BASE + path, init);
  return res.json();
}
const login = await call("/login/getToken", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ appid, secretKey }),
});
if (login.errcode !== 0) {
  console.error("Login failed:", login.errcode, login.errmsg);
  process.exit(1);
}
const TOKEN = login.token;
const get = (path, params) =>
  call(`${path}?${new URLSearchParams(params)}`, { headers: { TOKEN } });

const gw = await get("/v1/gateway/getGatewayOption", {});
const gateways = Array.isArray(gw.data) ? gw.data : [];
console.log("Gateways:", gateways.map((g) => `${g.no} (${g.deviceName || g.name || "?"})`).join(", ") || "none");
const no = process.argv[2] || String(gateways[0]?.no || "");
if (!no) process.exit(1);

const now = Date.now();
console.log(`\nGateway ${no} · now = ${ist(now)} IST = ${china(now)} China time\n`);

async function fetchRange(s, e) {
  const r = await get("/v1/gateway/getMeteorologicalData", {
    no,
    startDate: china(s),
    endDate: china(e),
  });
  if (r.errcode !== 0) throw new Error(`${r.errcode} ${r.errmsg}`);
  return r;
}

let shownShape = false;
const H = 3600000;
for (const hours of [1, 6, 24, 25, 48, 24 * 7]) {
  const s = now - hours * H;
  const direct = await fetchRange(s, now);
  if (!shownShape) {
    shownShape = true;
    const sample = direct.list?.[0];
    console.log("Response keys:", Object.keys(direct).join(", "));
    if (sample) {
      console.log("Record keys:  ", Object.keys(sample).join(", "));
      console.log("Sensor keys:  ", Object.keys(sample.data?.[0] || {}).join(", "));
      console.log("Sensors/record:", sample.data?.length, "→", (sample.data || []).map((x) => x.name).join(", "));
    }
    const extra = Object.entries(direct).filter(([k]) => !["list", "errcode", "errmsg"].includes(k));
    if (extra.length) console.log("Other fields:  ", JSON.stringify(Object.fromEntries(extra)).slice(0, 300));
    console.log("");
  }
  const seen = new Set();
  for (let c = s; c < now; c += H) {
    const part = await fetchRange(c, Math.min(c + H, now));
    (part.list || []).forEach((r) => seen.add(`${r.no}|${dateOf(r)}`));
  }
  const dates = (direct.list || []).map(dateOf).sort();
  const chunkDates = [...seen].map((k) => k.split("|")[1]).sort();
  const gaps = chunkDates.slice(1).map((d, i) =>
    Math.round((new Date(d.replace(" ", "T") + "+08:00") - new Date(chunkDates[i].replace(" ", "T") + "+08:00")) / 60000),
  );
  const med = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : "-";
  console.log(
    `${String(hours).padStart(4)} h | direct ${String(dates.length).padStart(5)} | chunked ${String(seen.size).padStart(5)}` +
      ` | newest direct: ${dates.at(-1) || "-"} | newest chunked: ${chunkDates.at(-1) || "-"} | typical gap: ${med} min` +
      (seen.size > dates.length ? "   ← API DROPS DATA FOR THIS RANGE" : ""),
  );
}
console.log("\n(times above are the raw API values = China time; IST = China − 2 h 30 min)");
