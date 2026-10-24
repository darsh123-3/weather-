// GET /api/meteo?no=<gateway>&startDate=YYYY-MM-DD HH:mm:ss&endDate=YYYY-MM-DD HH:mm:ss
// → every reading for one gateway in that range. Dates are China wall-time, as the
// vendor API expects.
//
// WHY CHUNKS: the vendor API does not return complete raw data for long ranges.
// Verified on 24 Oct 2026: a 24 h query returned the 24 Oct 02:12 pm reading, but a
// 41 h query that fully contains it returned only an older reading, and a 14-day
// query also omitted 24 Oct. So long ranges are split into small windows (≤ 24 h),
// fetched separately, and merged. Records are passed through unchanged; only exact
// duplicates (same gateway + same timestamp, from touching window edges) are removed.
import { HttpError, handle, vendorGet } from "./_vendor.js";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const NO_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HOUR = 3600000;
const CHUNK_MS = Math.min(24, Math.max(1, Number(process.env.WEATHER_CHUNK_HOURS) || 12)) * HOUR;
const CONCURRENCY = 4;
const MAX_RANGE_DAYS = 93;

// China wall-time string <-> a plain number we can do arithmetic on (no timezone math).
function toMs(text) {
  const m = DATE_RE.exec(text || "");
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}
const pad = (n) => String(n).padStart(2, "0");
function fromMs(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function recordKey(r, i, chunk) {
  const date = r?.gatherDate || r?.collectDate || r?.createTime || r?.time;
  // A record without a timestamp can't be matched safely, so it is always kept.
  return date ? `${r?.no ?? ""}|${date}` : `nodate|${chunk}|${i}`;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export default handle(async ({ no, startDate, endDate }) => {
  if (!no || !NO_RE.test(no)) throw new HttpError(400, "Invalid gateway number.");
  const start = toMs(startDate);
  const end = toMs(endDate);
  if (start === null || end === null)
    throw new HttpError(400, "Dates must be in the format YYYY-MM-DD HH:mm:ss.");
  if (start > end) throw new HttpError(400, "Start date/time must be before end date/time.");
  if (end - start > MAX_RANGE_DAYS * 24 * HOUR)
    throw new HttpError(400, `Please choose a range of ${MAX_RANGE_DAYS} days or less.`);

  const windows = [];
  for (let s = start; s < end || windows.length === 0; s += CHUNK_MS) {
    windows.push([s, Math.min(s + CHUNK_MS, end)]);
  }

  const lists = await mapLimit(windows, CONCURRENCY, async ([s, e]) => {
    const result = await vendorGet("/v1/gateway/getMeteorologicalData", {
      no,
      startDate: fromMs(s),
      endDate: fromMs(e),
    });
    return Array.isArray(result.list) ? result.list : [];
  });

  const seen = new Set();
  const list = [];
  lists.forEach((chunk, c) =>
    chunk.forEach((r, i) => {
      const key = recordKey(r, i, c);
      if (seen.has(key)) return;
      seen.add(key);
      list.push(r);
    }),
  );
  return { errcode: 0, list, windows: windows.length };
});
