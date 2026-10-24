import { memo, useEffect, useMemo, useState } from "react";
import { AlertCircle, LoaderCircle } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { computeDailyET0, ET0_RULES } from "./et0";
import { DEFAULT_LATITUDE, DEFAULT_WIND_HEIGHT, STATIONS } from "./stations";

const DAYS = 7;
const IST_OFFSET_MS = 330 * 60000;
const DAY_FMT = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short" });
const fmtDay = (key) => DAY_FMT.format(new Date(`${key}T00:00:00Z`));
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "—");
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "—");

function pickNumber(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (v !== null && v !== undefined && v !== "" && Number.isFinite(n)) return n;
  }
  return null;
}

/* Last DAYS complete IST days for one station → FAO-56 ET₀ per day.
   Fetched separately from the chart's date range so ET₀ always uses whole days. */
const ET0Section = memo(function ET0Section({ deviceNo, gateway, loadRecords, refreshKey, todayKey, darkMode }) {
  const [state, setState] = useState({ loading: false, error: "", days: [] });

  const cfg = STATIONS[String(deviceNo)] || {};
  const apiLat = pickNumber(gateway?.latitude, gateway?.lat);
  const lat = pickNumber(cfg.latitude, apiLat) ?? DEFAULT_LATITUDE;
  const latSource = cfg.latitude != null ? "station setting" : apiLat != null ? "station API" : "India default";
  const windHeight = pickNumber(cfg.windHeight) ?? DEFAULT_WIND_HEIGHT;

  useEffect(() => {
    if (!deviceNo) return undefined;
    let cancelled = false;
    const now = Date.now();
    const todayStartIST = Date.parse(`${todayKey}T00:00:00Z`) - IST_OFFSET_MS;
    const start = new Date(todayStartIST - DAYS * 86400000);
    Promise.resolve()
      .then(() => {
        if (!cancelled) setState((s) => ({ ...s, loading: true, error: "" }));
        return loadRecords(start, new Date(now));
      })
      .then((records) => {
        if (cancelled) return;
        const days = computeDailyET0(records, { lat, windHeight, now }).slice(0, DAYS);
        setState({ loading: false, error: "", days });
      })
      .catch((e) => {
        if (!cancelled) setState({ loading: false, error: e.message || "Unable to load ET₀ data.", days: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [deviceNo, todayKey, refreshKey, lat, windHeight, loadRecords]);

  const { days, loading, error } = state;
  const ok = days.filter((d) => d.status === "ok");
  const latest = ok[0] || null;
  const total = ok.reduce((a, d) => a + d.et0, 0);
  const noSolar = days.length > 0 && days.every((d) => d.status === "missing" && /solar/i.test(d.reason));
  const chartData = useMemo(
    () => [...days].reverse().map((d) => ({ day: fmtDay(d.date).replace(/^\w+,?\s*/, ""), et0: d.status === "ok" ? +d.et0.toFixed(2) : null })),
    [days],
  );
  const tick = darkMode ? "#7b8d88" : "#73857f";

  return (
    <section id="et0" className="section reveal d4">
      <div className="section-head">
        <div>
          <span className="kicker">Irrigation</span>
          <h2>Reference evapotranspiration (ET₀)</h2>
          <p>Daily crop water demand, calculated from this station's own readings with the FAO-56 Penman-Monteith method.</p>
        </div>
        <span className="count-pill">
          {loading && <LoaderCircle size={12} className="spin" />}
          Last {DAYS} days
        </span>
      </div>

      <div className="glass chart-panel et0-panel">
        {error ? (
          <div className="et0-note warn">
            <AlertCircle size={16} />
            {error}
          </div>
        ) : noSolar ? (
          <div className="et0-note warn">
            <AlertCircle size={16} />
            ET₀ can't be calculated for this station: it is not sending solar radiation readings. Showing no value is safer than showing a wrong one.
          </div>
        ) : null}

        <div className="stats">
          <div>
            <span>{latest ? `Latest complete day · ${fmtDay(latest.date)}` : "Latest complete day"}</span>
            <strong>
              {loading && !days.length ? <span className="skel skel-stat" /> : latest ? <>{f2(latest.et0)}<small>mm/day</small></> : "—"}
            </strong>
          </div>
          <div>
            <span>Total ({ok.length} of {DAYS} days)</span>
            <strong>{ok.length ? <>{f1(total)}<small>mm</small></> : "—"}</strong>
          </div>
          <div>
            <span>Daily average</span>
            <strong>{ok.length ? <>{f2(total / ok.length)}<small>mm/day</small></> : "—"}</strong>
          </div>
          <div>
            <span>Days calculated</span>
            <strong>{days.length ? `${ok.length}/${days.length}` : "—"}</strong>
          </div>
        </div>

        {ok.length > 0 && (
          <div className="chart-box et0-chart">
            <ResponsiveContainer width="100%" height="100%" debounce={80}>
              <BarChart data={chartData} margin={{ top: 12, right: 18, left: 0, bottom: 4 }}>
                <CartesianGrid stroke={darkMode ? "rgba(255,255,255,.06)" : "rgba(12,40,32,.07)"} strokeDasharray="3 6" vertical={false} />
                <XAxis dataKey="day" tick={{ fill: tick, fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis width={40} tick={{ fill: tick, fontSize: 11 }} tickLine={false} axisLine={false} unit="" />
                <Tooltip
                  isAnimationActive={false}
                  cursor={{ fill: darkMode ? "rgba(255,255,255,.04)" : "rgba(12,40,32,.04)" }}
                  contentStyle={{ background: darkMode ? "rgba(10,16,18,.96)" : "#fff", border: "1px solid rgba(128,128,128,.2)", borderRadius: 12, fontSize: 12 }}
                  formatter={(v) => [v == null ? "Not calculated" : `${v} mm/day`, "ET₀"]}
                />
                <Bar dataKey="et0" fill="#22b8cf" radius={[6, 6, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {days.length > 0 && (
          <div className="table-wrap et0-table">
            <table className="table">
              <thead>
                <tr>
                  <th>Day (IST)</th>
                  <th>ET₀ <small>mm/day</small></th>
                  <th>Temp max / min <small>°C</small></th>
                  <th>Humidity max / min <small>%</small></th>
                  <th>Wind (2 m) <small>m/s</small></th>
                  <th>Solar <small>MJ/m²</small></th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) =>
                  d.status === "ok" ? (
                    <tr key={d.date}>
                      <td className="time">{fmtDay(d.date)}</td>
                      <td className="num"><strong>{f2(d.et0)}</strong></td>
                      <td className="num">{f1(d.inputs.tmax)} / {f1(d.inputs.tmin)}</td>
                      <td className="num">{Math.round(d.inputs.rhmax)} / {Math.round(d.inputs.rhmin)}</td>
                      <td className="num">{f2(d.inputs.u2)}</td>
                      <td className="num">{f1(d.inputs.rs)}</td>
                    </tr>
                  ) : (
                    <tr key={d.date}>
                      <td className="time">{fmtDay(d.date)}</td>
                      <td colSpan={5} className="muted">
                        Not calculated — {d.reason}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !error && !days.length && deviceNo && (
          <div className="et0-note">No complete days of data in the last {DAYS} days.</div>
        )}

        <p className="et0-foot">
          ET₀ is the water a reference grass crop would use; multiply by your crop's coefficient (Kc) for crop water need.
          A day is calculated only when it is finished and temperature, humidity, wind and solar radiation cover at least{" "}
          {ET0_RULES.minCoverage * 100}% of it (no gap over {ET0_RULES.maxGapMin} min); otherwise it is left blank. Latitude{" "}
          {lat}° N ({latSource}) · wind sensor height {windHeight} m · pressure from the station sensor.
        </p>
      </div>
    </section>
  );
});

export default ET0Section;
