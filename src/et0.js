/* Reference evapotranspiration (ET₀, mm/day) — FAO-56 Penman-Monteith (daily).
   Allen et al. (1998), FAO Irrigation and Drainage Paper 56, equations 6–48.

   Everything is computed from the station's own readings. A day is only
   calculated when its data passes every quality check below; otherwise it is
   returned with a status + reason and NO value, so the UI never shows a wrong ET₀.

   Inputs per reading (normalised records from App.jsx): temperature (°C),
   humidity (%), wind speed (m/s), solar radiation (W/m²), air pressure (kPa/hPa). */

const IST_OFFSET_MS = 330 * 60000;
const DAY_MS = 86400000;

/* Quality rules */
export const ET0_RULES = {
  maxGapMin: 90, // a gap longer than this between readings breaks coverage
  minCoverage: 0.9, // ≥ 90 % of the day must be covered for every input
  rsMaxRatio: 1.1, // measured Rs may not exceed clear-sky Rso by > 10 % (sensor fault)
  maxET0: 15, // mm/day — physically implausible above this
};

/* Plausible ranges for a single reading — values outside are discarded as sensor errors. */
const RANGES = {
  temperature: [-20, 60],
  humidity: [1, 100],
  wind: [0, 60],
  solarRadiation: [0, 1500],
  pressure: [70, 110], // kPa
};

const REQUIRED = [
  ["temperature", "air temperature"],
  ["humidity", "air humidity"],
  ["wind", "wind speed"],
  ["solarRadiation", "solar radiation"],
];

/* ---------- unit normalisation ---------- */
function toSI(key, value, unit) {
  const u = String(unit || "").toLowerCase();
  if (key === "temperature" && /f/.test(u) && !/c/.test(u)) return ((value - 32) * 5) / 9;
  if (key === "wind" && /km/.test(u)) return value / 3.6;
  if (key === "pressure") {
    if (/hpa|mbar|mb/.test(u) || value > 200) return value / 10; // hPa → kPa
    if (/^pa$/.test(u) || value > 20000) return value / 1000; // Pa → kPa
  }
  return value;
}

/* ---------- FAO-56 core (daily) ---------- */
const satVP = (t) => 0.6108 * Math.exp((17.27 * t) / (t + 237.3)); // eq 11, kPa

function extraterrestrialRadiation(latDeg, doy) {
  const phi = (latDeg * Math.PI) / 180;
  const dr = 1 + 0.033 * Math.cos(((2 * Math.PI) / 365) * doy); // eq 23
  const dec = 0.409 * Math.sin(((2 * Math.PI) / 365) * doy - 1.39); // eq 24
  const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(dec)))); // eq 25
  return (
    ((24 * 60) / Math.PI) *
    0.082 *
    dr *
    (ws * Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.sin(ws))
  ); // eq 21, MJ m⁻² day⁻¹
}

/* Pure FAO-56 daily equation. Exported so it can be unit-tested against FAO Example 18. */
export function fao56Daily({ tmax, tmin, rhmax, rhmin, u2, rs, pressure, lat, doy, elevation }) {
  const tmean = (tmax + tmin) / 2; // eq 9
  const gamma = 0.000665 * pressure; // eq 8
  const delta = (4098 * satVP(tmean)) / (tmean + 237.3) ** 2; // eq 13
  const es = (satVP(tmax) + satVP(tmin)) / 2; // eq 12
  const ea = (satVP(tmin) * (rhmax / 100) + satVP(tmax) * (rhmin / 100)) / 2; // eq 17
  const ra = extraterrestrialRadiation(lat, doy);
  const rso = (0.75 + 2e-5 * elevation) * ra; // eq 37
  const rns = (1 - 0.23) * rs; // eq 38, grass albedo 0.23
  const sigma = 4.903e-9;
  const rnl =
    sigma *
    (((tmax + 273.16) ** 4 + (tmin + 273.16) ** 4) / 2) *
    (0.34 - 0.14 * Math.sqrt(Math.max(ea, 0))) *
    (1.35 * Math.min(Math.max(rs / rso, 0.3), 1) - 0.35); // eq 39 (Rs/Rso bounded 0.3–1.0, ASCE-EWRI 2005)
  const rn = rns - rnl; // eq 40
  const et0 =
    (0.408 * delta * rn + gamma * (900 / (tmean + 273)) * u2 * (es - ea)) /
    (delta + gamma * (1 + 0.34 * u2)); // eq 6 (G ≈ 0 for daily steps)
  return { et0, ra, rso, rn, es, ea };
}

/* Wind measured at height h (m) → 2 m (eq 47). */
export const windTo2m = (uz, h) => (h === 2 ? uz : (uz * 4.87) / Math.log(67.8 * h - 5.42));

/* Elevation implied by mean air pressure (inverse of eq 7). */
const elevationFromPressure = (p) => (293 - 293 * (p / 101.3) ** (1 / 5.26)) / 0.0065;

/* ---------- helpers on one day's series ---------- */
const istDayKey = (ts) => new Date(ts + IST_OFFSET_MS).toISOString().slice(0, 10);
const istDayStart = (key) => Date.parse(`${key}T00:00:00Z`) - IST_OFFSET_MS;

function coverage(points, start, end, maxGapMs) {
  if (!points.length) return 0;
  let covered = 0;
  const first = points[0].t - start;
  const last = end - points[points.length - 1].t;
  if (first <= maxGapMs) covered += first;
  if (last <= maxGapMs) covered += last;
  for (let i = 1; i < points.length; i++) {
    const gap = points[i].t - points[i - 1].t;
    if (gap <= maxGapMs) covered += gap;
  }
  return covered / (end - start);
}

/* Time-weighted mean / integral (trapezoid); edges hold the nearest value. */
function integrate(points, start, end) {
  let sum = (points[0].t - start) * points[0].v + (end - points.at(-1).t) * points.at(-1).v;
  for (let i = 1; i < points.length; i++)
    sum += ((points[i].t - points[i - 1].t) * (points[i].v + points[i - 1].v)) / 2;
  return sum; // value × ms
}

/* ---------- main: records → one result per complete IST day ---------- */
/**
 * @param records  normalised records [{ ts, sensors:[{ key, value, unit }] }]
 * @param opts     { lat, windHeight=2, now=Date.now() }
 * @returns [{ date, status:'ok'|'incomplete'|'missing'|'suspect', reason?, et0?, inputs? }]
 *          newest day first; today (unfinished) is never calculated.
 */
export function computeDailyET0(records, { lat, windHeight = 2, now = Date.now() } = {}) {
  const days = new Map();
  for (const r of records || []) {
    if (!r?.ts) continue;
    const key = istDayKey(r.ts);
    if (!days.has(key)) days.set(key, { temperature: [], humidity: [], wind: [], solarRadiation: [], pressure: [] });
    const d = days.get(key);
    for (const s of r.sensors || []) {
      if (!(s.key in d) || s.value === null || s.value === undefined) continue;
      const v = toSI(s.key, s.value, s.unit);
      const [lo, hi] = RANGES[s.key];
      if (Number.isFinite(v) && v >= lo && v <= hi) d[s.key].push({ t: r.ts, v });
    }
  }

  const maxGapMs = ET0_RULES.maxGapMin * 60000;
  const out = [];
  for (const [date, d] of days) {
    const start = istDayStart(date);
    const end = start + DAY_MS;
    if (end > now) continue; // today isn't finished — daily ET₀ would be wrong
    for (const k of Object.keys(d)) d[k].sort((a, b) => a.t - b.t);

    const missing = REQUIRED.filter(([k]) => !d[k].length).map(([, label]) => label);
    if (missing.length) {
      out.push({ date, status: "missing", reason: `No ${missing.join(", ")} data` });
      continue;
    }
    const cov = Object.fromEntries(REQUIRED.map(([k]) => [k, coverage(d[k], start, end, maxGapMs)]));
    const worst = Math.min(...Object.values(cov));
    if (worst < ET0_RULES.minCoverage) {
      out.push({
        date,
        status: "incomplete",
        reason: `Only ${Math.round(worst * 100)}% of the day has readings (needs ${ET0_RULES.minCoverage * 100}%)`,
      });
      continue;
    }
    if (!d.pressure.length) {
      out.push({ date, status: "missing", reason: "No air pressure data" });
      continue;
    }

    const T = d.temperature.map((p) => p.v);
    const RH = d.humidity.map((p) => p.v);
    const pressure = d.pressure.map((p) => p.v).sort((a, b) => a - b)[Math.floor(d.pressure.length / 2)]; // median
    const uz = integrate(d.wind, start, end) / DAY_MS;
    const rs = integrate(d.solarRadiation, start, end) / 1000 / 1e6; // W·ms/m² → MJ/m²
    const doy = Math.round((start + IST_OFFSET_MS - Date.UTC(new Date(start + IST_OFFSET_MS).getUTCFullYear(), 0, 0)) / DAY_MS);
    const inputs = {
      tmax: Math.max(...T),
      tmin: Math.min(...T),
      rhmax: Math.max(...RH),
      rhmin: Math.min(...RH),
      u2: windTo2m(uz, windHeight),
      rs,
      pressure,
      lat,
      doy,
      elevation: elevationFromPressure(pressure),
    };
    const res = fao56Daily(inputs);

    if (rs > ET0_RULES.rsMaxRatio * res.rso) {
      out.push({
        date,
        status: "suspect",
        reason: `Solar radiation (${rs.toFixed(1)} MJ/m²) is above the clear-sky maximum (${res.rso.toFixed(1)}) — sensor fault`,
      });
      continue;
    }
    if (!Number.isFinite(res.et0) || res.et0 > ET0_RULES.maxET0) {
      out.push({ date, status: "suspect", reason: "Calculated value is outside the physically possible range" });
      continue;
    }
    out.push({
      date,
      status: "ok",
      et0: Math.max(0, res.et0),
      inputs: { ...inputs, rso: res.rso, coverage: worst, readings: d.temperature.length },
    });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}
