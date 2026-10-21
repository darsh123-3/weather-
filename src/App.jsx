import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Activity,
  AlertCircle,
  CalendarDays,
  ChevronDown,
  Clock3,
  Cloud,
  Download,
  Droplets,
  Gauge,
  Leaf,
  LoaderCircle,
  RefreshCw,
  Search,
  Signal,
  SignalZero,
  Thermometer,
  Wind,
  Zap,
  Moon,
  Sun,
  LayoutGrid,
  TrendingUp,
  TrendingDown,
  Minus,
  Table,
  Radio,
  Database,
  Timer,
  Sparkles,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getGateways, getSensorData } from "./api";
import "./App.css";

const TZ = "Asia/Kolkata";
const TYPES = {
  temperature: {
    label: "Air Temperature",
    icon: Thermometer,
    color: "#ff7a45",
    unit: "°C",
    keys: [
      "weather temp",
      "weather temperature",
      "air temperature",
      "air temp",
      "大气温度",
      "温度",
    ],
  },
  humidity: {
    label: "Air Humidity",
    icon: Droplets,
    color: "#3b9cff",
    unit: "%",
    keys: [
      "weather humidity",
      "air humidity",
      "大气湿度",
      "大气湿度（rh）",
      "大气湿度(rh)",
      "湿度",
    ],
  },
  soilTemperature: {
    label: "Soil Temperature",
    icon: Thermometer,
    color: "#f5a524",
    unit: "°C",
    keys: ["soil temperature", "soil temp", "土壤温度"],
  },
  soilMoisture: {
    label: "Soil Moisture",
    icon: Droplets,
    color: "#22b8cf",
    unit: "%",
    keys: ["soil moisture", "土壤湿度"],
  },
  soilEC: {
    label: "Soil EC",
    icon: Activity,
    color: "#84cc16",
    unit: "µS/cm",
    keys: ["soil ec", "土壤ec"],
  },
  soilPH: {
    label: "Soil pH",
    icon: Leaf,
    color: "#10b981",
    unit: "pH",
    keys: [
      "soil ph",
      "soil acidity",
      "ph值",
      "土壤ph",
      "土壤ph（0.1）",
      "土壤ph(0.1)",
    ],
  },
  pressure: {
    label: "Air Pressure",
    icon: Gauge,
    color: "#9b7bff",
    unit: "hPa",
    keys: ["air pressure", "pressure", "气压"],
  },
  wind: {
    label: "Wind Speed",
    icon: Wind,
    color: "#14b8a6",
    unit: "m/s",
    keys: ["wind speed", "wind velocity", "风速"],
  },
  windDirection: {
    label: "Wind Direction",
    icon: Wind,
    color: "#5eead4",
    unit: "°",
    keys: ["wind direction", "风向"],
  },
  rainfall: {
    label: "Rainfall",
    icon: Droplets,
    color: "#6366f1",
    unit: "mm",
    keys: ["rainfall", "rain fall", "降雨量"],
  },
  solarRadiation: {
    label: "Solar Radiation",
    icon: Zap,
    color: "#facc15",
    unit: "W/m²",
    keys: ["solar radiation", "太阳辐射"],
  },
  light: {
    label: "Light",
    icon: Zap,
    color: "#eab308",
    unit: "kLux",
    keys: ["light", "illumination", "光照度"],
  },
  voltage: {
    label: "Device Voltage",
    icon: Zap,
    color: "#f59e0b",
    unit: "V",
    keys: ["voltage", "battery", "电压"],
  },
};
const pad = (n) => String(n).padStart(2, "0");
const IST_OFFSET_MINUTES = 330;
const CHINA_OFFSET_MINUTES = 480;
const CHART_MAX_POINTS = 480;
const TABLE_PAGE = 100;
// Machine status: ONLINE if the API returns any reading in this recent window, else OFFLINE.
// Station 2208 reports every ~126 min, so 6 h tolerates up to two missed reports.
const STATUS_WINDOW_HOURS = 6;
const STATUS_POLL_MS = 5 * 60000; // re-check every 5 minutes

/* Formatters are created ONCE. Calling toLocaleString(..., options) builds a new
   Intl formatter on every call, which was a major source of lag with many rows. */
const INPUT_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const DATE_FMT = new Intl.DateTimeFormat("en-IN", {
  timeZone: TZ,
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});
const SHORT_FMT = new Intl.DateTimeFormat("en-IN", {
  timeZone: TZ,
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});
const TIME_FMT = new Intl.DateTimeFormat("en-IN", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});
const NUM_FMT = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

// Build datetime-local values from IST wall-clock fields, independent of the PC timezone.
function localInput(date) {
  const parts = INPUT_FMT.formatToParts(date).reduce(
    (acc, p) => ((acc[p.type] = p.value), acc),
    {},
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function parseISTInput(value) {
  const m = String(value || "").match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/,
  );
  if (!m) return null;
  const [, y, mo, day, hour, minute] = m;
  const d = new Date(
    Date.UTC(+y, +mo - 1, +day, +hour, +minute) - IST_OFFSET_MINUTES * 60000,
  );
  return Number.isNaN(d.getTime()) ? null : d;
}
const initialRange = () => {
  const end = new Date();
  return {
    startDate: localInput(new Date(end.getTime() - 86400000)),
    endDate: localInput(end),
  };
};

/* API timestamps without an offset are treated as China Standard Time (UTC+08:00). */
function parseApiDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  // Epoch numbers are absolute instants (no timezone to apply). Seconds or milliseconds.
  if (/^\d{10}(\d{3})?$/.test(raw)) {
    const n = Number(raw);
    const d = new Date(raw.length === 10 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Normalise "2026/10/21 17:18:00" and "2026-10-21 17:18:00" to ISO "2026-10-21T17:18:00".
  let text = raw
    .replace(
      /^(\d{4})\/(\d{1,2})\/(\d{1,2})/,
      (_, y, m, d) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`,
    )
    .replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += "T00:00:00"; // date-only = China midnight
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text);
  const d = new Date(hasZone ? text : `${text}+08:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function displayDate(value) {
  const d = value instanceof Date ? value : parseApiDate(value);
  return d ? DATE_FMT.format(d) : "—";
}
function displayTime(value) {
  const d = value instanceof Date ? value : parseApiDate(value);
  return d ? TIME_FMT.format(d) : "—";
}

/* The picker is IST; the API expects timezone-free China wall-time parameters. */
function indiaInputToChina(value) {
  const istDate = parseISTInput(value);
  if (!istDate) return "";
  const china = new Date(istDate.getTime() + CHINA_OFFSET_MINUTES * 60000);
  return `${china.getUTCFullYear()}-${pad(china.getUTCMonth() + 1)}-${pad(china.getUTCDate())} ${pad(china.getUTCHours())}:${pad(china.getUTCMinutes())}:00`;
}
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (!s || ["null", "#", "--", "undefined"].includes(s.toLowerCase()))
    return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function recordDate(r) {
  return r?.gatherDate || r?.collectDate || r?.createTime || r?.time || "";
}
function normalizeSensorName(rawName, index, channelNo, oriName) {
  const candidates = [rawName, oriName]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const apiName =
    candidates.find((value) => !/[㐀-鿿]/.test(value)) || candidates[0];
  const compact = String(apiName || "")
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .trim();
  const aliasGroups = [
    {
      key: "temperature",
      names: [
        "weather temp",
        "weather temperature",
        "air temperature",
        "air temp",
        "ambient temperature",
        "大气温度",
        "温度",
      ],
    },
    {
      key: "humidity",
      names: [
        "weather humidity",
        "air humidity",
        "air hum",
        "relative humidity",
        "大气湿度",
        "大气湿度（rh）",
        "大气湿度(rh)",
        "湿度",
      ],
    },
    {
      key: "soilTemperature",
      names: ["soil temperature", "soil temp", "土壤温度"],
    },
    { key: "soilMoisture", names: ["soil moisture", "土壤湿度"] },
    {
      key: "soilEC",
      names: ["soil ec", "soil electrical conductivity", "土壤ec"],
    },
    {
      key: "soilPH",
      names: [
        "soil ph",
        "soil acidity",
        "ph值",
        "土壤ph",
        "土壤ph（0.1）",
        "土壤ph(0.1)",
      ],
    },
    { key: "pressure", names: ["air pressure", "pressure", "气压"] },
    { key: "wind", names: ["wind speed", "wind velocity", "风速"] },
    { key: "windDirection", names: ["wind direction", "风向"] },
    { key: "rainfall", names: ["rainfall", "rain fall", "降雨量"] },
    { key: "solarRadiation", names: ["solar radiation", "太阳辐射"] },
    {
      key: "light",
      names: ["light", "illumination", "light intensity", "光照度"],
    },
    { key: "voltage", names: ["voltage", "device voltage", "battery", "电压"] },
  ];
  const group = aliasGroups.find((item) =>
    item.names.some(
      (alias) =>
        alias
          .toLowerCase()
          .replace(/[\s_-]+/g, " ")
          .trim() === compact,
    ),
  );
  const key =
    group?.key ||
    (apiName ? `api:${compact}` : `channel:${channelNo ?? index}`);
  return { key, name: apiName || `Sensor channel ${channelNo ?? index + 1}` };
}

function normalize(records) {
  return (Array.isArray(records) ? records : [])
    .map((r, i) => {
      const bySensor = new Map();
      (Array.isArray(r?.data) ? r.data : []).forEach((s, j) => {
        const identity = normalizeSensorName(
          s?.name,
          j,
          s?.channelNo,
          s?.oriName,
        );
        const item = {
          id: identity.key,
          key: identity.key,
          name: identity.name,
          rawName: s?.name || s?.oriName || "",
          unit: s?.unit || "",
          value: num(s?.value),
          raw: s?.value,
        };
        const existing = bySensor.get(identity.key);
        if (!existing || (existing.value === null && item.value !== null))
          bySensor.set(identity.key, item);
      });
      const date = recordDate(r);
      // ts is parsed once here so sorting/filtering never re-parses dates.
      return {
        id: `${date}-${r?.no || ""}-${i}`,
        date,
        ts: parseApiDate(date)?.getTime() || 0,
        no: r?.no || "",
        sensors: [...bySensor.values()],
      };
    })
    .sort((a, b) => a.ts - b.ts);
}

function sensorType(name) {
  const s = String(name || "")
    .trim()
    .toLowerCase();
  for (const [key, t] of Object.entries(TYPES)) {
    if (
      t.keys.some((k) => k.toLowerCase() === s) ||
      t.label.toLowerCase() === s
    )
      return { ...t, key, label: name || t.label };
  }
  if (s.includes("temp"))
    return {
      key: "temperature",
      label: name || "Sensor",
      icon: Thermometer,
      color: "#ff7a45",
      unit: "°C",
    };
  if (s.includes("humid") || s.includes("moisture"))
    return {
      key: "humidity",
      label: name || "Sensor",
      icon: Droplets,
      color: "#3b9cff",
      unit: "%",
    };
  if (s.includes("pressure"))
    return {
      key: "pressure",
      label: name || "Sensor",
      icon: Gauge,
      color: "#9b7bff",
      unit: "hPa",
    };
  if (s.includes("wind"))
    return {
      key: "wind",
      label: name || "Sensor",
      icon: Wind,
      color: "#14b8a6",
      unit: "m/s",
    };
  if (s.includes("rain"))
    return {
      key: "rainfall",
      label: name || "Sensor",
      icon: Droplets,
      color: "#6366f1",
      unit: "mm",
    };
  if (s.includes("solar") || s.includes("radiation") || s.includes("light"))
    return {
      key: "light",
      label: name || "Sensor",
      icon: Zap,
      color: "#eab308",
      unit: "",
    };
  if (s.includes("ph"))
    return {
      key: "soilPH",
      label: name || "Sensor",
      icon: Leaf,
      color: "#10b981",
      unit: "pH",
    };
  if (s.includes("ec") || s.includes("conductivity"))
    return {
      key: "soilEC",
      label: name || "Sensor",
      icon: Activity,
      color: "#84cc16",
      unit: "",
    };
  return {
    key: "other",
    label: name || "Sensor",
    icon: Activity,
    color: "#34d399",
    unit: "",
  };
}

const fmt = (v) =>
  v === null || v === undefined || !Number.isFinite(Number(v))
    ? "—"
    : NUM_FMT.format(Number(v));

/* Min/max bucketing: keeps peaks and dips visible while capping points drawn. */
function downsample(points, max) {
  if (points.length <= max) return points;
  const size = Math.ceil(points.length / (max / 2));
  const out = [];
  for (let i = 0; i < points.length; i += size) {
    let lo = points[i],
      hi = points[i];
    const end = Math.min(i + size, points.length);
    for (let j = i + 1; j < end; j++) {
      if (points[j].value < lo.value) lo = points[j];
      if (points[j].value > hi.value) hi = points[j];
    }
    if (lo === hi) out.push(lo);
    else if (lo.t <= hi.t) out.push(lo, hi);
    else out.push(hi, lo);
  }
  return out;
}

function buildMatrix(records) {
  const sensors = new Map();
  records.forEach((record) =>
    record.sensors.forEach((sensor) => {
      const key = sensor.key || sensor.name;
      if (!sensors.has(key))
        sensors.set(key, { key, name: sensor.name, unit: sensor.unit || "" });
      else if (!sensors.get(key).unit && sensor.unit)
        sensors.get(key).unit = sensor.unit;
    }),
  );
  const columns = [...sensors.values()];
  const rows = [...records]
    .sort((a, b) => b.ts - a.ts)
    .map((record) => {
      const values = Object.fromEntries(
        record.sensors.map((sensor) => [
          sensor.key || sensor.name,
          sensor.raw ?? sensor.value ?? "",
        ]),
      );
      return {
        date: record.ts ? DATE_FMT.format(new Date(record.ts)) : "—",
        gateway: record.no,
        values,
      };
    });
  return { columns, rows };
}
function downloadFile(content, mimeType, filename) {
  const url = URL.createObjectURL(new Blob(["﻿", content], { type: mimeType }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportCsv(records) {
  if (!records.length) return;
  const { columns, rows } = buildMatrix(records);
  const data = [
    [
      "Date and time (IST)",
      ...columns.map((c) => `${c.name}${c.unit ? ` (${c.unit})` : ""}`),
    ],
    ...rows.map((row) => [
      row.date,
      ...columns.map((c) => row.values[c.key] ?? ""),
    ]),
  ];
  const csv = data
    .map((row) =>
      row.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","),
    )
    .join("\r\n");
  downloadFile(
    csv,
    "text/csv;charset=utf-8;",
    `micro-weather-readings-IST-${localInput(new Date()).slice(0, 10)}.csv`,
  );
}
function exportExcel(records) {
  if (!records.length) return;
  const { columns, rows } = buildMatrix(records);
  const escapeHtml = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const headers = [
    "Date and time (IST)",
    ...columns.map((c) => `${c.name}${c.unit ? ` (${c.unit})` : ""}`),
  ];
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>table{border-collapse:collapse;font-family:Calibri,Arial,sans-serif}th{background:#e8f3eb;color:#174b32;font-weight:bold}th,td{border:1px solid #cbd5ce;padding:8px 10px;text-align:left;white-space:nowrap}tbody tr:nth-child(even){background:#f6faf7}</style></head><body><table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.date)}</td>${columns.map((c) => `<td>${escapeHtml(row.values[c.key] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></body></html>`;
  downloadFile(
    html,
    "application/vnd.ms-excel;charset=utf-8;",
    `micro-weather-readings-IST-${localInput(new Date()).slice(0, 10)}.xls`,
  );
}

/* ---------------- Memoized building blocks ---------------- */

const Sparkline = memo(function Sparkline({ values, color, uid }) {
  if (!values || values.length < 2)
    return (
      <div className="spark spark-empty">
        <span>Waiting for trend data</span>
      </div>
    );
  const w = 120,
    h = 40;
  let min = Infinity,
    max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const line = values
    .map(
      (v, i) =>
        `${i ? "L" : "M"}${((i / (values.length - 1)) * w).toFixed(2)},${(h - 4 - ((v - min) / span) * (h - 8)).toFixed(2)}`,
    )
    .join(" ");
  const gid = `spark-${uid}`;
  return (
    <svg
      className="spark"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity=".32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w},${h} L0,${h} Z`} fill={`url(#${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
});

const SensorCard = memo(function SensorCard({
  sensor,
  latest,
  values,
  active,
  idx,
  onSelect,
  refreshing,
}) {
  const t = sensorType(sensor.name),
    Icon = t.icon;
  const delta =
    values && values.length > 1 ? values[values.length - 1] - values[0] : null;
  const dir =
    delta === null ? "flat" : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const TrendIcon =
    dir === "up" ? TrendingUp : dir === "down" ? TrendingDown : Minus;
  const unit = latest
    ? latest.unit || sensor.unit || t.unit
    : sensor.unit || t.unit;
  return (
    <button
      type="button"
      className={`sensor-card ${active ? "is-active" : ""} ${refreshing ? "is-refreshing" : ""}`}
      style={{ "--c": t.color, animationDelay: `${Math.min(idx, 10) * 45}ms` }}
      onClick={() => onSelect(sensor.key)}
      aria-pressed={active}
    >
      <div className="sc-head">
        <span className="sc-icon">
          <Icon size={17} />
        </span>
        <span className="sc-name" title={sensor.name}>
          {sensor.name}
        </span>
        {active && <span className="sc-badge">Charting</span>}
      </div>
      <div className="sc-value">
        <span>{latest ? fmt(latest.value) : "—"}</span>
        <small>{unit}</small>
      </div>
      <Sparkline values={values} color={t.color} uid={idx} />
      <div className="sc-foot">
        <span className={`sc-delta ${dir}`}>
          <TrendIcon size={13} />
          {delta === null
            ? "No trend yet"
            : `${delta > 0 ? "+" : ""}${fmt(delta)} in range`}
        </span>
        <span className="sc-live">
          {refreshing ? (
            <>
              <LoaderCircle size={11} className="spin" />
              Updating
            </>
          ) : (
            <>
              <i />
              Latest
            </>
          )}
        </span>
      </div>
    </button>
  );
});

const TrendChart = memo(function TrendChart({
  data,
  color,
  unit,
  name,
  darkMode,
}) {
  const ui = darkMode
    ? {
        grid: "rgba(255,255,255,.06)",
        tick: "#7b8d88",
        tipBg: "rgba(10,16,18,.96)",
        tipBorder: "rgba(255,255,255,.1)",
        tipText: "#e8f1ee",
        dot: "#0a1012",
      }
    : {
        grid: "rgba(12,40,32,.07)",
        tick: "#73857f",
        tipBg: "rgba(255,255,255,.98)",
        tipBorder: "rgba(12,40,32,.1)",
        tipText: "#0c1d18",
        dot: "#ffffff",
      };
  return (
    <ResponsiveContainer width="100%" height="100%" debounce={80}>
      <AreaChart
        data={data}
        margin={{ top: 12, right: 18, left: 0, bottom: 4 }}
      >
        <defs>
          <linearGradient id="mainGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid
          stroke={ui.grid}
          strokeDasharray="3 6"
          vertical={false}
        />
        <XAxis
          dataKey="label"
          tick={{ fill: ui.tick, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          minTickGap={48}
        />
        <YAxis
          width={48}
          tick={{ fill: ui.tick, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          domain={["auto", "auto"]}
        />
        <Tooltip
          isAnimationActive={false}
          cursor={{
            stroke: color,
            strokeOpacity: 0.35,
            strokeDasharray: "4 4",
          }}
          contentStyle={{
            background: ui.tipBg,
            border: `1px solid ${ui.tipBorder}`,
            borderRadius: 12,
            boxShadow: "0 16px 40px rgba(0,0,0,.25)",
            fontSize: 12,
          }}
          labelStyle={{ color: ui.tipText, fontWeight: 600, marginBottom: 4 }}
          itemStyle={{ color }}
          formatter={(v) => [`${fmt(v)} ${unit}`, name]}
          labelFormatter={(label, payload) =>
            payload?.[0]?.payload?.t
              ? DATE_FMT.format(new Date(payload[0].payload.t))
              : label
          }
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2.2}
          fill="url(#mainGradient)"
          activeDot={{ r: 5, strokeWidth: 2, stroke: ui.dot }}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
});

/* The readings table owns its own search/paging state, so typing in the search box
   or switching chart tabs never re-renders hundreds of table rows. */
const ReadingsSection = memo(function ReadingsSection({ records, loading }) {
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().toLowerCase());
  const searching = query !== search.trim().toLowerCase();
  const [limit, setLimit] = useState(TABLE_PAGE);
  const [exporting, setExporting] = useState(null);
  useEffect(() => {
    setLimit(TABLE_PAGE);
  }, [records, query]);

  const { columns, rows } = useMemo(() => {
    const cols = new Map();
    records.forEach((r) =>
      r.sensors.forEach((s) => {
        const k = s.key || s.name;
        if (!cols.has(k))
          cols.set(k, { key: k, name: s.name, unit: s.unit || "" });
        else if (!cols.get(k).unit && s.unit) cols.get(k).unit = s.unit;
      }),
    );
    const list = [...records]
      .sort((a, b) => b.ts - a.ts)
      .map((r) => {
        const dateLabel = r.ts ? DATE_FMT.format(new Date(r.ts)) : "—";
        const values = {};
        let hay = `${dateLabel} ${r.date}`;
        r.sensors.forEach((s) => {
          values[s.key || s.name] = fmt(s.value);
          hay += ` ${s.name} ${s.rawName}`;
        });
        return { key: r.id, dateLabel, values, hay: hay.toLowerCase() };
      });
    return { columns: [...cols.values()], rows: list };
  }, [records]);

  const filtered = useMemo(
    () => (query ? rows.filter((r) => r.hay.includes(query)) : rows),
    [rows, query],
  );
  const visible = filtered.slice(0, limit);
  const firstLoad = loading && !rows.length;

  const runExport = (kind) => {
    setExporting(kind);
    // Let the spinner paint before the (synchronous) file build starts.
    window.setTimeout(() => {
      try {
        kind === "csv" ? exportCsv(records) : exportExcel(records);
      } finally {
        setExporting(null);
      }
    }, 50);
  };

  return (
    <section id="readings" className="section reveal d4">
      <div className="section-head">
        <div>
          <span className="kicker">Recorded data</span>
          <h2>Sensor readings</h2>
          <p>One row per reading time, one column per sensor. Newest first.</p>
        </div>
        <div className="export-actions">
          <button
            className="btn-ghost"
            onClick={() => runExport("excel")}
            disabled={!records.length || !!exporting}
          >
            {exporting === "excel" ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Download size={15} />
            )}
            {exporting === "excel" ? "Preparing…" : "Excel"}
          </button>
          <button
            className="btn-ghost"
            onClick={() => runExport("csv")}
            disabled={!records.length || !!exporting}
          >
            {exporting === "csv" ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Download size={15} />
            )}
            {exporting === "csv" ? "Preparing…" : "CSV"}
          </button>
        </div>
      </div>
      <div className="table-toolbar">
        <div className="search">
          {searching ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Search size={16} />
          )}
          <input
            type="search"
            placeholder="Search sensor or timestamp…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="muted small">
          {loading && <LoaderCircle size={13} className="spin" />}Showing{" "}
          {Math.min(limit, filtered.length)} of {filtered.length} rows ·{" "}
          {columns.length} sensors
        </span>
      </div>
      <div
        className={`glass table-wrap ${loading && rows.length ? "is-busy" : ""}`}
        aria-busy={loading}
      >
        {loading && rows.length > 0 && (
          <div className="table-busy">
            <LoaderCircle size={14} className="spin" />
            Refreshing readings…
          </div>
        )}
        <table className="table">
          <thead>
            <tr>
              <th className="sticky-col">Date & time (IST)</th>
              {firstLoad
                ? Array.from({ length: 5 }).map((_, i) => (
                    <th key={i}>
                      <span className="skel skel-cell" />
                    </th>
                  ))
                : columns.map((s) => (
                    <th key={s.key}>
                      {s.name}
                      {s.unit ? <small>{` ${s.unit}`}</small> : null}
                    </th>
                  ))}
            </tr>
          </thead>
          <tbody>
            {firstLoad &&
              Array.from({ length: 7 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  <td className="sticky-col">
                    <span className="skel skel-cell wide" />
                  </td>
                  {Array.from({ length: 5 }).map((__, j) => (
                    <td key={j}>
                      <span className="skel skel-cell" />
                    </td>
                  ))}
                </tr>
              ))}
            {visible.map((row) => (
              <tr key={row.key}>
                <td className="sticky-col time">{row.dateLabel}</td>
                {columns.map((c) => {
                  const v = row.values[c.key];
                  return (
                    <td key={c.key} className="num">
                      {v && v !== "—" ? v : <span className="muted">—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
            {!loading && !filtered.length && (
              <tr>
                <td
                  colSpan={Math.max(1, columns.length + 1)}
                  className="table-empty"
                >
                  No readings found for this selection.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {filtered.length > limit && (
        <div className="load-more">
          <button
            className="btn-ghost"
            onClick={() => setLimit((l) => l + TABLE_PAGE * 2)}
          >
            Show {Math.min(TABLE_PAGE * 2, filtered.length - limit)} more
          </button>
          <button
            className="btn-link"
            onClick={() => setLimit(filtered.length)}
          >
            Show all {filtered.length}
          </button>
        </div>
      )}
      <div className="table-foot">
        <span>Source: selected weather station API</span>
        <span>{records.length} timestamp groups · newest first · IST</span>
      </div>
    </section>
  );
});

/* Checks the machine itself, independent of the date range the user is viewing:
   data in the last STATUS_WINDOW_HOURS → "online"; empty → "offline"; request failed → "unreachable". */
function useMachineStatus(deviceNo, refreshKey) {
  const [status, setStatus] = useState({ state: "unknown", lastSeen: null });
  useEffect(() => {
    if (!deviceNo) {
      setStatus({ state: "unknown", lastSeen: null });
      return undefined;
    }
    let cancelled = false;
    setStatus({ state: "checking", lastSeen: null });
    async function check() {
      try {
        const end = new Date();
        const start = new Date(end.getTime() - STATUS_WINDOW_HOURS * 3600000);
        const data = await getSensorData(
          deviceNo,
          indiaInputToChina(localInput(start)),
          indiaInputToChina(localInput(end)),
        );
        if (cancelled) return;
        const recs = normalize(data); // oldest → newest
        setStatus(
          recs.length
            ? { state: "online", lastSeen: recs[recs.length - 1].ts || null }
            : { state: "offline", lastSeen: null },
        );
      } catch {
        if (!cancelled) setStatus({ state: "unreachable", lastSeen: null });
      }
    }
    check();
    const timer = window.setInterval(check, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [deviceNo, refreshKey]);
  return status;
}

const NAV = [
  { id: "overview", label: "Overview", icon: LayoutGrid },
  { id: "trends", label: "Trends", icon: TrendingUp },
  { id: "readings", label: "Readings", icon: Table },
];

export default function App() {
  const [darkMode, setDarkMode] = useState(() => {
    try {
      return localStorage.getItem("evergreen-theme") !== "light";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("evergreen-theme", darkMode ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }, [darkMode]);
  const [activeNav, setActiveNav] = useState("overview");
  const [gateways, setGateways] = useState([]);
  const [selectedNo, setSelectedNo] = useState("");
  const [records, setRecords] = useState([]);
  const [selectedSensor, setSelectedSensor] = useState("");
  const [loadingGateways, setLoadingGateways] = useState(true);
  const [loading, setLoading] = useState(false);
  const [connection, setConnection] = useState("unknown");
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [range, setRange] = useState(initialRange);
  const [startDate, setStartDate] = useState(range.startDate);
  const [endDate, setEndDate] = useState(range.endDate);

  const gateway = useMemo(
    () => gateways.find((g) => String(g.no) === String(selectedNo)),
    [gateways, selectedNo],
  );
  const loadGateways = useCallback(async () => {
    setLoadingGateways(true);
    try {
      const data = await getGateways();
      const list = Array.isArray(data) ? data : [];
      setGateways(list);
      setSelectedNo((old) =>
        old && list.some((g) => String(g.no) === String(old))
          ? old
          : list.length
            ? String(list[0].no)
            : "",
      );
      if (!list.length) setError("No gateways were returned by the API.");
    } catch (e) {
      setConnection("offline");
      setError(e.message || "Unable to load gateways.");
    } finally {
      setLoadingGateways(false);
    }
  }, []);
  useEffect(() => {
    loadGateways();
  }, [loadGateways]);

  useEffect(() => {
    if (!selectedNo) {
      setRecords([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      setConnection("checking");
      try {
        const data = await getSensorData(
          selectedNo,
          indiaInputToChina(range.startDate),
          indiaInputToChina(range.endDate),
        );
        if (cancelled) return;
        setRecords(normalize(data));
        setLastUpdated(new Date());
        setConnection("online");
      } catch (e) {
        if (cancelled) return;
        setRecords([]);
        setConnection("offline");
        setError(e.message || "Unable to retrieve station readings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [selectedNo, range, refresh]);

  /* One pass over the records builds everything the cards and chart need. */
  const { sensors, seriesByKey, latestByKey, sparkByKey } = useMemo(() => {
    const meta = new Map(),
      series = new Map(),
      latest = new Map();
    records.forEach((r) =>
      r.sensors.forEach((s) => {
        const k = s.key || s.name;
        const m = meta.get(k);
        if (!m) meta.set(k, { key: k, name: s.name, unit: s.unit || "" });
        else {
          if (s.name) m.name = s.name;
          if (s.unit) m.unit = s.unit;
        }
        if (s.value === null) return;
        if (!series.has(k)) series.set(k, []);
        series.get(k).push({ t: r.ts, value: s.value });
        latest.set(k, s); // records are oldest→newest, so the last write is the latest
      }),
    );
    const spark = new Map();
    series.forEach((pts, k) => {
      const step = Math.max(1, Math.ceil(pts.length / 48));
      spark.set(
        k,
        pts
          .filter((_, i) => i % step === 0 || i === pts.length - 1)
          .map((p) => p.value),
      );
    });
    return {
      sensors: [...meta.values()],
      seriesByKey: series,
      latestByKey: latest,
      sparkByKey: spark,
    };
  }, [records]);

  useEffect(() => {
    if (!sensors.length) {
      setSelectedSensor("");
      return;
    }
    if (!sensors.some((sensor) => sensor.key === selectedSensor))
      setSelectedSensor(
        (
          sensors.find(
            (sensor) => sensorType(sensor.name).key === "temperature",
          ) || sensors[0]
        ).key,
      );
  }, [sensors, selectedSensor]);

  /* Tabs highlight instantly; the chart catches up in the background (no frozen clicks). */
  const chartSensor = useDeferredValue(selectedSensor);
  const switching = chartSensor !== selectedSensor;

  const selectedSensorInfo = sensors.find(
    (sensor) => sensor.key === selectedSensor,
  );
  const type = sensorType(selectedSensorInfo?.name || selectedSensor);
  const current = latestByKey.get(selectedSensor) || null;
  const chartInfo = sensors.find((s) => s.key === chartSensor);
  const chartType = sensorType(chartInfo?.name || chartSensor);

  const chartView = useMemo(() => {
    const pts = seriesByKey.get(chartSensor) || [];
    if (!pts.length)
      return { data: [], stats: { avg: null, min: null, max: null }, count: 0 };
    let sum = 0,
      min = Infinity,
      max = -Infinity;
    for (const p of pts) {
      sum += p.value;
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
    }
    const spanMs = pts[pts.length - 1].t - pts[0].t;
    const labelFmt = spanMs > 36 * 3600000 ? SHORT_FMT : TIME_FMT;
    const data = downsample(pts, CHART_MAX_POINTS).map((p) => ({
      t: p.t,
      value: p.value,
      label: p.t ? labelFmt.format(new Date(p.t)) : "",
    }));
    return {
      data,
      stats: { avg: sum / pts.length, min, max },
      count: pts.length,
    };
  }, [seriesByKey, chartSensor]);

  const rangeHours = useMemo(() => {
    const s = parseISTInput(range.startDate),
      e = parseISTInput(range.endDate);
    return s && e ? Math.max(0, Math.round((e - s) / 3600000)) : null;
  }, [range]);
  const maxInput = useMemo(() => localInput(new Date()), [lastUpdated]);

  const machine = useMachineStatus(selectedNo, refresh);
  const machineState = machine.state;
  const lastSeenText = machine.lastSeen
    ? `Last reading ${displayDate(new Date(machine.lastSeen))}`
    : `Data received in the last ${STATUS_WINDOW_HOURS} h`;
  const status = {
    online: { label: "Online", detail: lastSeenText, icon: Signal },
    offline: {
      label: "Offline",
      detail: `No data in the last ${STATUS_WINDOW_HOURS} h`,
      icon: SignalZero,
    },
    unreachable: {
      label: "API unreachable",
      detail: "Couldn't reach the station API",
      icon: AlertCircle,
    },
    checking: {
      label: "Checking",
      detail: "Checking machine status…",
      icon: LoaderCircle,
    },
    unknown: {
      label: "Standby",
      detail: "No station selected",
      icon: AlertCircle,
    },
  }[machineState] || {
    label: "Standby",
    detail: "No station selected",
    icon: AlertCircle,
  };
  const StatusIcon = status.icon;
  const busy = loading || loadingGateways;
  const firstLoad = busy && !records.length;

  function applyRange() {
    if (!startDate || !endDate)
      return setError("Please select both start and end date/time.");
    const startInstant = parseISTInput(startDate);
    const endInstant = parseISTInput(endDate);
    if (!startInstant || !endInstant)
      return setError("Please enter valid start and end date/time values.");
    if (startInstant > endInstant)
      return setError("Start date/time must be before end date/time.");
    if (endInstant > new Date())
      return setError("End date/time cannot be in the future (IST).");
    setError("");
    setRange({ startDate, endDate });
  }

  return (
    <div className={`app ${darkMode ? "theme-dark" : "theme-light"}`}>
      <div className="bg-mesh" aria-hidden="true">
        <span className="blob b1" />
        <span className="blob b2" />
        <span className="blob b3" />
        <div className="grid-overlay" />
      </div>

      <aside className="sidebar">
        <a
          className="brand"
          href="#overview"
          aria-label="FZ Evergreen Agro Tech India"
          onClick={() => setActiveNav("overview")}
        >
          <div className="brand-logo">
            <img
              src="/cmp_logo.png"
              alt="FZ Evergreen Agro Tech India logo"
              onError={(e) => {
                e.currentTarget.style.display = "none";
                e.currentTarget.parentElement.classList.add("logo-fallback");
              }}
            />
            <Leaf className="logo-fallback-icon" size={22} />
          </div>
          <div className="brand-copy">
            <strong>FZ Evergreen</strong>
            <span>Agro Tech India</span>
          </div>
        </a>

        <nav className="nav" aria-label="Sections">
          <span className="nav-caption">Workspace</span>
          {NAV.map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={`#${id}`}
              className={`nav-item ${activeNav === id ? "is-active" : ""}`}
              onClick={() => setActiveNav(id)}
            >
              <Icon size={17} />
              <span>{label}</span>
            </a>
          ))}
        </nav>

        <div className="live-module">
          <div className="live-orbit">
            <span className="ring r1" />
            <span className="ring r2" />
            <span className="core">
              {busy ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <Radio size={17} />
              )}
            </span>
          </div>
          <div className="live-copy">
            <span className="live-eyebrow">
              <i />
              Live telemetry
            </span>
            <strong>
              {firstLoad ? (
                <span className="skel skel-line" />
              ) : (
                `${sensors.length} channels`
              )}
            </strong>
            <span>
              {busy ? "Syncing with station…" : "discovered on this station"}
            </span>
          </div>
        </div>

        <div className={`side-connection ${machineState}`}>
          <div className="side-connection-icon">
            {machineState === "checking" ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <Cloud size={17} />
            )}
          </div>
          <div className="side-connection-copy">
            <strong>
              {machineState === "unreachable"
                ? "API unreachable"
                : `Machine ${status.label.toLowerCase()}`}
            </strong>
            <span title={status.detail}>{status.detail}</span>
          </div>
          <i className="dot" />
        </div>
        <div className="side-footer">
          <Leaf size={13} />
          Technology for smarter agriculture
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <div className="topbar-brand">
              <Leaf size={18} />
              <strong>FZ Evergreen</strong>
            </div>
            <div className="breadcrumb">
              <span>Monitoring</span>
              <span className="sep">/</span>
              <strong>Micro weather station</strong>
            </div>
          </div>
          <div className="topbar-right">
            <span
              className={`status-pill ${machineState}`}
              title={status.detail}
            >
              {machineState === "checking" ? (
                <LoaderCircle size={12} className="spin" />
              ) : (
                <i />
              )}
              {status.label}
            </span>
            <button
              type="button"
              className="icon-button with-label"
              onClick={() => setRefresh((v) => v + 1)}
              disabled={busy || !selectedNo}
              aria-label="Refresh station"
              title="Refresh station"
            >
              <RefreshCw size={16} className={loading ? "spin" : ""} />
              <span>{loading ? "Refreshing…" : "Refresh"}</span>
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => setDarkMode((v) => !v)}
              aria-label={
                darkMode ? "Switch to light mode" : "Switch to dark mode"
              }
              title={darkMode ? "Light mode" : "Dark mode"}
            >
              {darkMode ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <div className="avatar" title="FZ Evergreen Agro Tech India">
              FZ
            </div>
          </div>
          <div
            className={`top-progress ${busy ? "on" : ""}`}
            aria-hidden="true"
          />
        </header>

        <div className="page">
          <section className="hero reveal">
            <div className="hero-copy">
              <span className="hero-tag">
                <Sparkles size={13} />
                FZ Evergreen Agro Tech India
              </span>
              <h1>
                Micro Weather <span className="grad">Station</span>
              </h1>
              <p>
                Real-time field conditions, sensor health and historical climate
                trends — in one live view.
              </p>
              <div className="chips">
                <span className="chip">
                  <Clock3 size={13} />
                  IST · UTC+05:30
                </span>
                {loading ? (
                  <span className="chip">
                    <LoaderCircle size={13} className="spin" />
                    Syncing…
                  </span>
                ) : (
                  lastUpdated && (
                    <span className="chip">
                      <Signal size={13} />
                      Synced {displayTime(lastUpdated)}
                    </span>
                  )
                )}
              </div>
            </div>
          </section>

          <section className="bento reveal d1">
            <div className="glass station-card">
              <div className="station-top">
                <div className="station-visual">
                  {loadingGateways ? (
                    <LoaderCircle size={24} className="spin" />
                  ) : (
                    <Cloud size={26} />
                  )}
                  <i />
                </div>
                <div className="station-details">
                  <span className="label">Selected station</span>
                  {loadingGateways ? (
                    <span className="skel skel-title" />
                  ) : (
                    <h2>
                      {gateway?.deviceName ||
                        gateway?.name ||
                        "Micro weather station"}
                    </h2>
                  )}
                  <div className="station-meta">
                    <span
                      className={`status-pill ${machineState}`}
                      title={status.detail}
                    >
                      {machineState === "checking" ? (
                        <LoaderCircle size={12} className="spin" />
                      ) : (
                        <i />
                      )}
                      {status.label}
                    </span>
                    {gateway?.no && (
                      <span className="mono muted">ID · {gateway.no}</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="gateway-picker">
                <label htmlFor="gateway-select">Gateway</label>
                <div
                  className={`select ${loadingGateways ? "is-loading" : ""}`}
                >
                  <select
                    id="gateway-select"
                    value={selectedNo}
                    onChange={(e) => {
                      setSelectedNo(e.target.value);
                      setConnection("checking");
                    }}
                    disabled={loadingGateways || !gateways.length}
                  >
                    {loadingGateways && (
                      <option value="">Loading gateways…</option>
                    )}
                    {!loadingGateways && !gateways.length && (
                      <option value="">No gateways available</option>
                    )}
                    {gateways.map((g, i) => (
                      <option key={`${g.no}-${i}`} value={String(g.no)}>
                        {g.deviceName || g.name || `Gateway ${g.no}`}
                        {g.no ? ` (${g.no})` : ""}
                      </option>
                    ))}
                  </select>
                  {loadingGateways ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <ChevronDown size={16} />
                  )}
                </div>
                <span className="hint">
                  <StatusIcon
                    size={12}
                    className={machineState === "checking" ? "spin" : ""}
                  />
                  {status.detail}
                </span>
              </div>
            </div>

            <div className="glass kpi">
              <span className="kpi-icon">
                <Radio size={16} />
              </span>
              <span className="kpi-label">Active sensors</span>
              <strong className="kpi-value">
                {firstLoad ? (
                  <span className="skel skel-num" />
                ) : (
                  sensors.length
                )}
              </strong>
            </div>
            <div className="glass kpi">
              <span className="kpi-icon">
                <Database size={16} />
              </span>
              <span className="kpi-label">Readings loaded</span>
              <strong className="kpi-value">
                {firstLoad ? (
                  <span className="skel skel-num" />
                ) : (
                  NUM_FMT.format(records.length)
                )}
              </strong>
            </div>
            <div className="glass kpi">
              <span className="kpi-icon">
                <Timer size={16} />
              </span>
              <span className="kpi-label">Time window</span>
              <strong className="kpi-value">
                {rangeHours === null ? (
                  "—"
                ) : rangeHours >= 72 ? (
                  <>
                    {Math.round(rangeHours / 24)}
                    <small>days</small>
                  </>
                ) : (
                  <>
                    {rangeHours}
                    <small>h</small>
                  </>
                )}
              </strong>
            </div>
          </section>

          {error && (
            <div className="error-banner" role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label="Dismiss error">
                ×
              </button>
            </div>
          )}

          <section id="overview" className="section reveal d2">
            <div className="section-head">
              <div>
                <span className="kicker">Live overview</span>
                <h2>Environmental conditions</h2>
                <p>
                  Latest valid reading from each channel, with its trend across
                  the selected window.
                </p>
              </div>
              <span className="count-pill">
                {loading && <LoaderCircle size={12} className="spin" />}
                {sensors.length} sensors
              </span>
            </div>
            {firstLoad ? (
              <div className="sensor-grid">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="sensor-card skeleton" />
                ))}
              </div>
            ) : sensors.length ? (
              <div className="sensor-grid">
                {sensors.map((s, i) => (
                  <SensorCard
                    key={s.key}
                    sensor={s}
                    idx={i}
                    latest={latestByKey.get(s.key)}
                    values={sparkByKey.get(s.key)}
                    active={selectedSensor === s.key}
                    onSelect={setSelectedSensor}
                    refreshing={loading}
                  />
                ))}
              </div>
            ) : (
              <div className="glass empty">
                <Activity size={24} />
                <strong>No sensor readings available</strong>
                <span>Check the connection or select another date range.</span>
              </div>
            )}
          </section>

          <section id="trends" className="section reveal d3">
            <div className="section-head">
              <div>
                <span className="kicker">Data explorer</span>
                <h2>Historical trends</h2>
                <p>
                  Pick an IST window and a sensor to explore how conditions
                  changed.
                </p>
              </div>
              {lastUpdated && (
                <span className="muted small">
                  {loading ? (
                    <LoaderCircle size={13} className="spin" />
                  ) : (
                    <Clock3 size={13} />
                  )}
                  {loading
                    ? "Updating…"
                    : `Updated ${displayTime(lastUpdated)}`}
                </span>
              )}
            </div>

            <div className="glass chart-panel">
              <div className="range-bar">
                <div className="range-title">
                  <span className="kpi-icon">
                    <CalendarDays size={16} />
                  </span>
                  <div>
                    <strong>Date range</strong>
                    <span>Indian Standard Time</span>
                  </div>
                </div>
                <div className="range-fields">
                  <label className="field">
                    <span>Start</span>
                    <input
                      type="datetime-local"
                      value={startDate}
                      max={endDate || undefined}
                      onChange={(e) => setStartDate(e.target.value)}
                      disabled={loading}
                    />
                  </label>
                  <label className="field">
                    <span>End</span>
                    <input
                      type="datetime-local"
                      value={endDate}
                      min={startDate || undefined}
                      max={maxInput}
                      onChange={(e) => setEndDate(e.target.value)}
                      disabled={loading}
                    />
                  </label>
                  <button
                    className="btn-primary"
                    onClick={applyRange}
                    disabled={loading}
                  >
                    {loading ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <Search size={15} />
                    )}
                    {loading ? "Loading…" : "Apply"}
                  </button>
                </div>
              </div>
              <div className="range-note">
                Showing {displayDate(parseISTInput(range.startDate))} →{" "}
                {displayDate(parseISTInput(range.endDate))}
              </div>

              <div className="tabs" role="tablist">
                {firstLoad
                  ? Array.from({ length: 5 }).map((_, i) => (
                      <span key={i} className="skel skel-tab" />
                    ))
                  : sensors.map((s) => {
                      const t = sensorType(s.name),
                        Icon = t.icon;
                      const on = selectedSensor === s.key;
                      return (
                        <button
                          key={s.key}
                          role="tab"
                          aria-selected={on}
                          className={on ? "is-active" : ""}
                          style={{ "--c": t.color }}
                          onClick={() => setSelectedSensor(s.key)}
                        >
                          {on && switching ? (
                            <LoaderCircle size={14} className="spin" />
                          ) : (
                            <Icon size={14} />
                          )}
                          {s.name}
                        </button>
                      );
                    })}
              </div>

              <div className="chart-head">
                <div className="chart-title">
                  <i
                    style={{
                      background: type.color,
                      boxShadow: `0 0 16px ${type.color}`,
                    }}
                  />
                  <div>
                    <h3>{selectedSensorInfo?.name || "Select a sensor"}</h3>
                    <span>
                      {switching
                        ? "Loading chart…"
                        : `${chartView.count} valid data points${chartView.data.length < chartView.count ? ` · ${chartView.data.length} plotted` : ""} · IST`}
                    </span>
                  </div>
                </div>
                <div className="chart-latest">
                  <span>Latest</span>
                  <strong>
                    {current ? fmt(current.value) : "—"}
                    <small>
                      {current ? current.unit || type.unit : type.unit}
                    </small>
                  </strong>
                </div>
              </div>

              <div className={`stats ${switching ? "is-stale" : ""}`}>
                <div>
                  <span>Average</span>
                  <strong>
                    {firstLoad ? (
                      <span className="skel skel-stat" />
                    ) : (
                      <>
                        {fmt(chartView.stats.avg)}
                        {chartView.stats.avg !== null && (
                          <small>{chartType.unit}</small>
                        )}
                      </>
                    )}
                  </strong>
                </div>
                <div>
                  <span>Minimum</span>
                  <strong>
                    {firstLoad ? (
                      <span className="skel skel-stat" />
                    ) : (
                      <>
                        {fmt(chartView.stats.min)}
                        {chartView.stats.min !== null && (
                          <small>{chartType.unit}</small>
                        )}
                      </>
                    )}
                  </strong>
                </div>
                <div>
                  <span>Maximum</span>
                  <strong>
                    {firstLoad ? (
                      <span className="skel skel-stat" />
                    ) : (
                      <>
                        {fmt(chartView.stats.max)}
                        {chartView.stats.max !== null && (
                          <small>{chartType.unit}</small>
                        )}
                      </>
                    )}
                  </strong>
                </div>
                <div>
                  <span>Readings</span>
                  <strong>
                    {firstLoad ? (
                      <span className="skel skel-stat" />
                    ) : (
                      chartView.count
                    )}
                  </strong>
                </div>
              </div>

              <div className={`chart-box ${switching ? "is-switching" : ""}`}>
                {loading && (
                  <div className="chart-loading">
                    <LoaderCircle size={22} className="spin" />
                    {records.length
                      ? "Updating readings…"
                      : "Fetching readings…"}
                  </div>
                )}
                {switching && !loading && (
                  <div className="chart-switching">
                    <LoaderCircle size={13} className="spin" />
                    Loading {selectedSensorInfo?.name}
                  </div>
                )}
                {!loading && !chartView.data.length ? (
                  <div className="chart-empty">
                    <Activity size={26} />
                    <strong>No data in this time range</strong>
                    <span>Try another sensor or widen your date range.</span>
                  </div>
                ) : chartView.data.length ? (
                  <TrendChart
                    data={chartView.data}
                    color={chartType.color}
                    unit={chartType.unit}
                    name={chartInfo?.name || chartType.label}
                    darkMode={darkMode}
                  />
                ) : null}
              </div>
            </div>
          </section>

          <ReadingsSection records={records} loading={loading} />

          <footer className="page-footer">
            <span>
              <Leaf size={14} />
              FZ Evergreen Agro Tech India
            </span>
            <span>Micro Weather Station · IST (UTC+05:30)</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
