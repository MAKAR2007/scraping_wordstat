"use strict";

// hist — полная месячная история по всем регионам РФ; regions считаются на
// клиенте под выбранный период (поэтому меняются и цифры, и лидеры).
let state = {
  marketPhrase: "", otpPhrase: "", year: null,
  subjects: [], hist: { keys: [], labels: [], market: [], otp: [] },
  regions: [], dynRegion: "ALL", bucketLabel: "",
};
let charts = {};
let topLimit = 15;

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n || 0).toLocaleString("ru-RU");
const fmtPct = (v) => { v = Number(v) || 0; return v.toFixed(v < 1 ? 3 : 2).replace(".", ",") + "%"; };
const signPct = (v, d = 1) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d).replace(".", ",") + " %";

const C = {
  market: "#7AB829", marketSoft: "rgba(122,184,41,.16)",
  otp: "#6C4CF1", otpSoft: "rgba(108,76,241,.18)", orange: "#FF7A1A",
};
const PIE_COLORS = ["#6C4CF1", "#7AB829", "#FF7A1A", "#22B8CF", "#E8467C",
  "#F5B301", "#2F9E6E", "#9B5DE5", "#3D7BF0", "#FF6B6B"];
const OTHERS_COLOR = "#C7CCD8";
const SEASON_COLORS = ["#C9E3A6", "#A8D572", "#7AB829", "#FF9E45", "#5F9A1E"];
const SEASON_OTP = ["#D9CDF6", "#B6A6FB", "#9277F8", "#FF9E45", "#6C4CF1"];
const MONTH_ABBR = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

if (window.Chart) {
  Chart.defaults.font.family = "Inter, -apple-system, Segoe UI, Roboto, sans-serif";
  Chart.defaults.color = "#475063";
}

// Плагин квадрантов для матрицы возможностей.
const quadrantPlugin = {
  id: "quad",
  afterDraw(chart) {
    const o = chart.options.plugins.quad;
    if (!o || o.medX == null) return;
    const { ctx, chartArea: { left, right, top, bottom }, scales: { x, y } } = chart;
    const px = x.getPixelForValue(o.medX), py = y.getPixelForValue(o.medY);
    ctx.save();
    ctx.strokeStyle = "rgba(90,100,120,.30)"; ctx.setLineDash([6, 5]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = "rgba(72,80,99,.55)"; ctx.font = "700 11px Inter, sans-serif";
    ctx.fillText("высокая доля ОТП", left + 8, top + 15);
    ctx.fillText("приоритет роста →", px + 10, bottom - 10);
    ctx.restore();
  },
};

document.addEventListener("DOMContentLoaded", () => {
  checkStatus();
  $("searchForm").addEventListener("submit", onSearch);
  $("exportBtn").addEventListener("click", onExport);
  $("tableFilter").addEventListener("input", renderRegionsTable);
  $("dynRegion").addEventListener("change", () => { state.dynRegion = $("dynRegion").value || "ALL"; renderDynamicsChart(); });
  $("device").addEventListener("change", () => { if (state.marketPhrase) $("searchForm").requestSubmit(); });
  $("period").addEventListener("change", () => { if (state.marketPhrase) onPeriodChange(); });
  document.querySelectorAll(".toggle-btn").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".toggle-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      topLimit = parseInt(b.dataset.top, 10);
      renderRegionsChart();
    });
  });
});

async function checkStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    const badge = $("modeBadge");
    badge.textContent = s.demo ? "демо-режим" : "рабочий режим";
    badge.className = "badge " + (s.demo ? "badge--demo" : "badge--live");
  } catch (e) { /* игнорируем */ }
}

async function onSearch(e) {
  e.preventDefault();
  const phrase = $("phrase").value.trim();
  if (!phrase) return;
  showError("");
  $("results").classList.add("hidden");
  $("loader").classList.remove("hidden");
  $("searchBtn").disabled = true;
  try {
    const resp = await fetch("/api/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phrase, devices: [$("device").value] }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Ошибка запроса");
    state.marketPhrase = data.marketPhrase;
    state.otpPhrase = data.otpPhrase;
    state.year = data.year;
    state.subjects = data.subjects || [];
    state.hist = data.dynamics || { keys: [], labels: [], market: [], otp: [] };
    state.dynRegion = "ALL";
    populateRegionSelect();
    renderAll();
    $("results").classList.remove("hidden");
  } catch (err) {
    showError(err.message);
  } finally {
    $("loader").classList.add("hidden");
    $("searchBtn").disabled = false;
  }
}

function renderAll() {
  $("statOtpLabel").textContent = "Доля «" + state.otpPhrase + "» от общих";
  $("exportBtn").disabled = false;
  recomputeRegions();
  renderKpi();
  renderLeaders();
  renderStrategicKpis();
  renderPeriodViews();
  renderSeasonalityChart("market", "seasonalityChart", "seasonality");
  renderSeasonalityChart("otp", "seasonalityOtpChart", "seasonalityOtp");
}

function onPeriodChange() {
  recomputeRegions();
  renderKpi();
  renderLeaders();
  renderStrategicKpis();
  renderPeriodViews();
}

// Всё, что зависит от выбранного периода (бакет регионов + графики периода).
function renderPeriodViews() {
  renderRegionsChart();
  renderDynamicsChart();
  renderPenetrationChart();
  renderGrowthIndexChart();
  renderForecastChart();
  renderDistChart();
  renderPenByRegionChart();
  renderOpportunityChart();
  renderShareChart("shareOtp", "otp");
  renderShareChart("shareMarket", "market");
  renderRegionsTable();
}

// ---------------------------------------------- агрегация и текущий бакет --
function periodKey() { return $("period").value || "year"; }
function periodUnit() { const p = periodKey(); return p === "year" ? "год" : p === "quarter" ? "квартал" : "месяц"; }

function aggregate(hist, period) {
  if (period === "month") {
    return { labels: hist.labels.slice(), market: hist.market.slice(), otp: hist.otp.slice(), counts: hist.keys.map(() => 1) };
  }
  const order = [], map = {};
  hist.keys.forEach((k, i) => {
    const y = k.slice(0, 4), m = parseInt(k.slice(5, 7), 10);
    const id = period === "year" ? y : y + "Q" + Math.ceil(m / 3);
    const label = period === "year" ? y : Math.ceil(m / 3) + " кв. " + y;
    if (!(id in map)) { map[id] = { market: 0, otp: 0, count: 0, label }; order.push(id); }
    map[id].market += hist.market[i]; map[id].otp += hist.otp[i]; map[id].count += 1;
  });
  return {
    labels: order.map((id) => map[id].label), market: order.map((id) => map[id].market),
    otp: order.map((id) => map[id].otp), counts: order.map((id) => map[id].count),
  };
}

function currentBucket() {
  const period = periodKey();
  const agg = aggregate(state.hist, period);
  const need = period === "year" ? 12 : period === "quarter" ? 3 : 1;
  const full = [];
  for (let i = 0; i < agg.counts.length; i++) if (agg.counts[i] >= need) full.push(i);
  const li = full.length ? full[full.length - 1] : agg.market.length - 1;
  return { agg, full, li, period, M: li >= 0 ? agg.market[li] : 0, O: li >= 0 ? agg.otp[li] : 0, label: li >= 0 ? agg.labels[li] : "—" };
}

// ------------------------------------ детерминированное распределение по РФ --
function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rand01(s) { return (hashStr(s) % 100000) / 100000; }

function fixSum(arr, target) {
  let d = target - arr.reduce((a, b) => a + b, 0);
  if (!d) return;
  let mi = 0; for (let i = 1; i < arr.length; i++) if (arr[i] > arr[mi]) mi = i;
  arr[mi] = Math.max(0, arr[mi] + d);
}
function fixSumClamped(arr, target, caps) {
  let d = target - arr.reduce((a, b) => a + b, 0);
  const order = caps.map((c, i) => i).sort((a, b) => caps[b] - caps[a]);
  let k = 0, guard = arr.length * 5 + 20;
  while (d !== 0 && k < guard) {
    const i = order[k % order.length];
    if (d > 0 && arr[i] < caps[i]) { arr[i]++; d--; }
    else if (d < 0 && arr[i] > 0) { arr[i]--; d++; }
    k++;
  }
}

function computeRegions(subjects, phrase, bkey, M, O) {
  if (!subjects.length) return [];
  const w = subjects.map((s) => (0.3 + rand01(phrase + "|b|" + s.id)) * (0.55 + 0.9 * rand01(phrase + "|" + bkey + "|" + s.id)));
  const sw = w.reduce((a, b) => a + b, 0) || 1;
  const market = subjects.map((s, i) => Math.max(0, Math.round(M * w[i] / sw)));
  fixSum(market, M);
  const baseShare = M ? O / M : 0;
  const rawO = subjects.map((s, i) => market[i] * baseShare * (0.5 + rand01(phrase + "|o|" + bkey + "|" + s.id)));
  const so = rawO.reduce((a, b) => a + b, 0) || 1;
  const otp = subjects.map((s, i) => Math.min(market[i], Math.max(0, Math.round(rawO[i] * O / so))));
  fixSumClamped(otp, O, market);
  return subjects.map((s, i) => ({
    id: s.id, name: s.name, market: market[i], otp: otp[i],
    penetration: market[i] ? +(otp[i] / market[i] * 100).toFixed(3) : 0,
    marketShare: M ? +(market[i] / M * 100).toFixed(2) : 0,
    otpShare: O ? +(otp[i] / O * 100).toFixed(2) : 0,
    affinityIndex: 50 + (hashStr(phrase + "|a|" + s.id) % 120),
  })).sort((a, b) => b.market - a.market);
}

function recomputeRegions() {
  const b = currentBucket();
  state.bucketLabel = b.label;
  state.regions = computeRegions(state.subjects, state.marketPhrase, b.label, b.M, b.O);
}

function regionFractions(regionId) {
  const wm = state.subjects.map((s) => 0.3 + rand01(state.marketPhrase + "|b|" + s.id));
  const wo = state.subjects.map((s, i) => wm[i] * (0.5 + rand01(state.marketPhrase + "|of|" + s.id)));
  const swm = wm.reduce((a, b) => a + b, 0) || 1, swo = wo.reduce((a, b) => a + b, 0) || 1;
  const i = state.subjects.findIndex((s) => s.id === regionId);
  return i >= 0 ? { fm: wm[i] / swm, fo: wo[i] / swo } : { fm: 1, fo: 1 };
}

function currentDynHist() {
  if (state.dynRegion === "ALL") return state.hist;
  const { fm, fo } = regionFractions(state.dynRegion);
  return {
    keys: state.hist.keys, labels: state.hist.labels,
    market: state.hist.market.map((v) => Math.round(v * fm)),
    otp: state.hist.otp.map((v) => Math.round(v * fo)),
  };
}

// --------------------------------------------------------------- KPI ряды --
function renderLeaders() {
  $("statLeader").textContent = state.regions[0] ? state.regions[0].name : "—";
  const lo = state.regions.reduce((a, b) => (!a || b.otp > a.otp ? b : a), null);
  $("statLeaderOtp").textContent = lo ? lo.name : "—";
}

function renderKpi() {
  const b = currentBucket();
  const market = b.M, otp = b.O, share = market ? otp / market * 100 : 0;
  $("statMarket").textContent = fmt(market);
  $("statMarketFoot").textContent = "за " + b.label;
  $("statOtpShare").textContent = share.toFixed(3).replace(".", ",") + "%";
  $("statOtpFoot").textContent = "за " + b.label;
  $("regionsPeriodNote").textContent = "за " + b.label;

  [["Market", "market"], ["Otp", "otp"]].forEach(([suf, field]) => {
    const el = $("growth" + suf), foot = $("growth" + suf + "Foot");
    if (b.full.length < 2 || !b.agg[field][b.full[b.full.length - 2]]) {
      el.textContent = "—"; el.className = "stat-value"; foot.textContent = "недостаточно данных"; return;
    }
    const i1 = b.full[b.full.length - 2], i2 = b.full[b.full.length - 1];
    const pct = (b.agg[field][i2] - b.agg[field][i1]) / b.agg[field][i1] * 100;
    el.textContent = signPct(pct); el.className = "stat-value " + (pct >= 0 ? "growth-up" : "growth-down");
    foot.textContent = b.agg.labels[i2] + " к " + b.agg.labels[i1];
  });

  const peak = (field) => {
    let hi = -1, hidx = -1;
    b.full.forEach((i) => { if (b.agg[field][i] > hi) { hi = b.agg[field][i]; hidx = i; } });
    return { label: hidx >= 0 ? b.agg.labels[hidx] : "—", val: hi > 0 ? hi : 0 };
  };
  const unit = periodUnit(), pm = peak("market"), po = peak("otp");
  $("peakMarket").textContent = fmt(pm.val);
  $("peakMarketFoot").textContent = "рекордный " + unit + " · " + pm.label;
  $("peakOtp").textContent = fmt(po.val);
  $("peakOtpFoot").textContent = "рекордный " + unit + " · " + po.label;
}

function renderStrategicKpis() {
  const ya = aggregate(state.hist, "year");
  const full = [];
  for (let i = 0; i < ya.counts.length; i++) if (ya.counts[i] >= 12) full.push(i);
  const cagr = (arr) => {
    if (full.length < 2) return null;
    const a = arr[full[0]], b = arr[full[full.length - 1]], yrs = full.length - 1;
    if (a <= 0 || yrs <= 0) return null;
    return (Math.pow(b / a, 1 / yrs) - 1) * 100;
  };
  const setG = (id, v) => {
    const el = $(id);
    if (v == null) { el.textContent = "—"; el.className = "stat-value stat-value--md"; return; }
    el.textContent = signPct(v); el.className = "stat-value stat-value--md " + (v >= 0 ? "growth-up" : "growth-down");
  };
  const cm = cagr(ya.market), co = cagr(ya.otp);
  setG("kpiCagrMarket", cm); setG("kpiCagrOtp", co);

  let pen = null;
  if (full.length >= 2) {
    const i2 = full[full.length - 1], i1 = full[full.length - 2];
    const p2 = ya.market[i2] ? ya.otp[i2] / ya.market[i2] * 100 : 0;
    const p1 = ya.market[i1] ? ya.otp[i1] / ya.market[i1] * 100 : 0;
    pen = p2 - p1;
  }
  const pd = $("kpiPenDelta");
  if (pen == null) { pd.textContent = "—"; pd.className = "stat-value stat-value--md"; }
  else { pd.textContent = (pen >= 0 ? "+" : "−") + Math.abs(pen).toFixed(2).replace(".", ",") + " п.п."; pd.className = "stat-value stat-value--md " + (pen >= 0 ? "growth-up" : "growth-down"); }

  const sorted = [...state.regions].sort((a, b) => b.market - a.market);
  const tot = sorted.reduce((a, r) => a + r.market, 0) || 1;
  const top5 = sorted.slice(0, 5).reduce((a, r) => a + r.market, 0);
  $("kpiConcentration").textContent = (top5 / tot * 100).toFixed(1).replace(".", ",") + "%";

  if (cm != null && co != null) {
    $("strategicNote").textContent = co > cm
      ? "Бренд ОТП растёт быстрее рынка (CAGR ОТП " + signPct(co) + " против " + signPct(cm) + ") — доля увеличивается."
      : "Рынок растёт быстрее бренда — есть риск отставания доли ОТП.";
  }
}

// ----------------------------------------------------- регионы: рынок+ОТП --
function destroy(name) { if (charts[name]) { charts[name].destroy(); charts[name] = null; } }

function renderRegionsChart() {
  const rows = state.regions.slice(0, topLimit);
  $("regionsChart").parentElement.style.height = Math.max(420, rows.length * 27) + "px";
  destroy("regions");
  charts.regions = new Chart($("regionsChart"), {
    type: "bar",
    data: {
      labels: rows.map((r) => r.name),
      datasets: [
        { key: "market", label: "Рынок", data: rows.map((r) => r.market), backgroundColor: C.market, borderRadius: 4, categoryPercentage: .76, barPercentage: .92 },
        { key: "otp", label: "ОТП", data: rows.map((r) => r.otp), backgroundColor: C.otp, borderRadius: 4, categoryPercentage: .76, barPercentage: .92 },
      ],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: { label: (ctx) => {
          const r = rows[ctx.dataIndex];
          return ctx.dataset.key === "market" ? "Рынок: " + fmt(r.market) : "ОТП: " + fmt(r.otp) + " · доля ОТП " + fmtPct(r.penetration);
        } } },
      },
      scales: { x: { ticks: { callback: shortNum } }, y: { ticks: { autoSkip: false, font: { size: 11 } } } },
    },
  });
}

function renderDynamicsChart() {
  const agg = aggregate(currentDynHist(), periodKey());
  destroy("dynamics");
  charts.dynamics = new Chart($("dynamicsChart"), {
    type: "line",
    data: {
      labels: agg.labels,
      datasets: [
        { label: "ОТП", data: agg.otp, yAxisID: "yOtp", borderColor: C.otp, backgroundColor: C.otpSoft, fill: true, tension: .35, pointRadius: 0, borderWidth: 2.5 },
        { label: "Рынок", data: agg.market, yAxisID: "yMarket", borderColor: C.market, backgroundColor: C.marketSoft, fill: false, tension: .35, pointRadius: 0, borderWidth: 2.5 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: {
          label: (c) => " " + c.dataset.label + ": " + fmt(c.parsed.y),
          afterBody: (items) => { const i = items[0].dataIndex; const m = agg.market[i], o = agg.otp[i]; return m ? "доля ОТП: " + (o / m * 100).toFixed(2).replace(".", ",") + "%" : ""; },
        } },
      },
      scales: {
        yOtp: { position: "left", title: { display: true, text: "ОТП", color: C.otp }, ticks: { callback: shortNum, color: C.otp }, grid: { color: "#f1f1f8" } },
        yMarket: { position: "right", title: { display: true, text: "Рынок", color: C.market }, ticks: { callback: shortNum, color: C.market }, grid: { drawOnChartArea: false } },
        x: { ticks: { maxRotation: 50, minRotation: 45, autoSkip: true, font: { size: 10 } } },
      },
    },
  });
}

function renderPenetrationChart() {
  const agg = aggregate(state.hist, periodKey());
  const share = agg.market.map((m, i) => (m ? agg.otp[i] / m * 100 : 0));
  destroy("penetration");
  charts.penetration = new Chart($("penetrationChart"), {
    type: "line",
    data: { labels: agg.labels, datasets: [{ label: "Доля ОТП, %", data: share, borderColor: C.otp, backgroundColor: C.otpSoft, fill: true, tension: .35, pointRadius: 0, borderWidth: 2.5 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => " доля ОТП: " + c.parsed.y.toFixed(3).replace(".", ",") + "%" } } },
      scales: { x: { ticks: { maxRotation: 50, minRotation: 45, autoSkip: true, font: { size: 10 } } }, y: { ticks: { callback: (v) => v.toFixed(1).replace(".", ",") + "%" } } },
    },
  });
}

function renderGrowthIndexChart() {
  const agg = aggregate(state.hist, periodKey());
  const i0m = agg.market.findIndex((v) => v > 0), i0o = agg.otp.findIndex((v) => v > 0);
  const bM = i0m >= 0 ? agg.market[i0m] : 0, bO = i0o >= 0 ? agg.otp[i0o] : 0;
  const idxM = agg.market.map((v) => (bM ? v / bM * 100 : null));
  const idxO = agg.otp.map((v) => (bO ? v / bO * 100 : null));
  destroy("growthIndex");
  charts.growthIndex = new Chart($("growthIndexChart"), {
    type: "line",
    data: {
      labels: agg.labels,
      datasets: [
        { label: "Рынок", data: idxM, borderColor: C.market, backgroundColor: "transparent", tension: .35, pointRadius: 0, borderWidth: 2.5, spanGaps: true },
        { label: "ОТП", data: idxO, borderColor: C.otp, backgroundColor: "transparent", tension: .35, pointRadius: 0, borderWidth: 2.5, spanGaps: true },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: {
          label: (c) => " " + c.dataset.label + ": " + Math.round(c.parsed.y),
          afterBody: (items) => {
            const i = items[0].dataIndex;
            if (idxM[i] == null || idxO[i] == null) return "";
            const d = idxO[i] - idxM[i];
            return "разрыв ОТП−рынок: " + (d >= 0 ? "+" : "−") + Math.abs(Math.round(d)) + " п.";
          },
        } },
      },
      scales: { x: { ticks: { maxRotation: 50, minRotation: 45, autoSkip: true, font: { size: 10 } } }, y: { ticks: { callback: (v) => Math.round(v) } } },
    },
  });
}

function renderForecastChart() {
  const h = state.hist;
  const share = h.market.map((m, i) => (m ? h.otp[i] / m * 100 : 0));
  const n = share.length, lastK = Math.min(24, n), start = n - lastK;
  const histLabels = h.labels.slice(start), histShare = share.slice(start);
  const fit = linreg(histShare);
  const K = 6, futLabels = nextMonthLabels(h.keys[n - 1], K);
  const labels = histLabels.concat(futLabels);
  const actual = histShare.concat(new Array(K).fill(null));
  const forecast = new Array(lastK - 1).fill(null);
  forecast.push(histShare[histShare.length - 1]);
  for (let k = 1; k <= K; k++) forecast.push(Math.max(0, fit.slope * (lastK - 1 + k) + fit.intercept));
  destroy("forecast");
  charts.forecast = new Chart($("forecastChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Факт", data: actual, borderColor: C.otp, backgroundColor: C.otpSoft, fill: true, tension: .3, pointRadius: 0, borderWidth: 2.5 },
        { label: "Прогноз", data: forecast, borderColor: C.orange, borderDash: [6, 5], backgroundColor: "transparent", tension: .2, pointRadius: 0, borderWidth: 2.5 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: true, position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: { label: (c) => c.parsed.y == null ? "" : " " + c.dataset.label + ": " + c.parsed.y.toFixed(2).replace(".", ",") + "%" } } },
      scales: { x: { ticks: { maxRotation: 50, minRotation: 45, autoSkip: true, font: { size: 10 } } }, y: { ticks: { callback: (v) => v.toFixed(1).replace(".", ",") + "%" } } },
    },
  });
}

function renderDistChart() {
  const { labels, data } = buildHistogram(state.regions.map((r) => r.market));
  destroy("dist");
  charts.dist = new Chart($("distChart"), {
    type: "bar",
    data: { labels, datasets: [{ label: "Регионов", data, backgroundColor: C.orange, borderRadius: 5 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.parsed.y + " регион(ов)" } } },
      scales: { x: { ticks: { font: { size: 10 } }, grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: "число регионов" } } },
    },
  });
}

function renderPenByRegionChart() {
  const rows = [...state.regions].filter((r) => r.market > 0).sort((a, b) => b.penetration - a.penetration).slice(0, 15);
  destroy("penByRegion");
  charts.penByRegion = new Chart($("penByRegionChart"), {
    type: "bar",
    data: { labels: rows.map((r) => r.name), datasets: [{ label: "Доля ОТП, %", data: rows.map((r) => r.penetration), backgroundColor: C.otp, borderRadius: 4 }] },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => {
        const r = rows[c.dataIndex]; return " доля ОТП " + fmtPct(r.penetration) + " · ОТП " + fmt(r.otp) + " из " + fmt(r.market);
      } } } },
      scales: { x: { ticks: { callback: (v) => v.toFixed(1).replace(".", ",") + "%" } }, y: { ticks: { font: { size: 11 } } } },
    },
  });
}

function renderSeasonalityChart(metric, canvasId, chartKey) {
  const h = state.hist, years = {};
  h.keys.forEach((k, i) => { const y = k.slice(0, 4), m = parseInt(k.slice(5, 7), 10) - 1; (years[y] = years[y] || new Array(12).fill(null))[m] = h[metric][i]; });
  const recent = Object.keys(years).sort().slice(-5);
  const palette = metric === "otp" ? SEASON_OTP : SEASON_COLORS;
  const datasets = recent.map((y, idx) => ({
    label: y, data: years[y], borderColor: palette[idx % palette.length], backgroundColor: "transparent",
    tension: .35, pointRadius: 0, spanGaps: true, borderWidth: idx === recent.length - 1 ? 3 : 1.8,
  }));
  destroy(chartKey);
  charts[chartKey] = new Chart($(canvasId), {
    type: "line", data: { labels: MONTH_ABBR, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: true, position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: { label: (c) => " " + c.dataset.label + ": " + fmt(c.parsed.y) } } },
      scales: { y: { ticks: { callback: shortNum } } },
    },
  });
}

function renderOpportunityChart() {
  const regs = [...state.regions].sort((a, b) => b.market - a.market).slice(0, 40).filter((r) => r.market > 0);
  const median = (arr) => { const s = [...arr].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
  const medX = median(regs.map((r) => r.market));
  const totM = regs.reduce((a, r) => a + r.market, 0), totO = regs.reduce((a, r) => a + r.otp, 0);
  const medY = totM ? totO / totM * 100 : 0;
  const maxO = Math.max(...regs.map((r) => r.otp), 1);
  const pts = regs.map((r) => {
    const opp = r.market >= medX && r.penetration < medY;
    const lead = r.market >= medX && r.penetration >= medY;
    const niche = r.market < medX && r.penetration >= medY;
    const color = opp ? C.orange : lead ? C.market : niche ? C.otp : "#AEB6C4";
    return { x: r.market, y: r.penetration, r: 5 + Math.sqrt(r.otp / maxO) * 16, name: r.name, otp: r.otp, color };
  });
  destroy("opportunity");
  charts.opportunity = new Chart($("opportunityChart"), {
    type: "bubble",
    data: { datasets: [{ data: pts, backgroundColor: pts.map((p) => hexA(p.color, .55)), borderColor: pts.map((p) => p.color), borderWidth: 1.5 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false }, quad: { medX, medY },
        tooltip: { callbacks: { label: (c) => { const p = c.raw; return " " + p.name + ": рынок " + fmt(p.x) + ", доля ОТП " + p.y.toFixed(2).replace(".", ",") + "%, ОТП " + fmt(p.otp); } } },
      },
      scales: {
        x: { title: { display: true, text: "Спрос (рынок), показы" }, ticks: { callback: shortNum } },
        y: { title: { display: true, text: "Доля ОТП, %" }, ticks: { callback: (v) => v.toFixed(1).replace(".", ",") + "%" } },
      },
    },
    plugins: [quadrantPlugin],
  });
}

function renderShareChart(name, key) {
  const canvas = name === "shareOtp" ? "shareOtpChart" : "shareMarketChart";
  const sorted = [...state.regions].sort((a, b) => b[key] - a[key]);
  const top = sorted.slice(0, 10);
  const restSum = sorted.slice(10).reduce((s, r) => s + (r[key] || 0), 0);
  const labels = top.map((r) => r.name);
  const data = top.map((r) => r[key]);
  const bg = PIE_COLORS.slice(0, top.length);
  let othersIdx = -1;
  if (restSum > 0) { labels.push("Остальные регионы"); data.push(restSum); bg.push(OTHERS_COLOR); othersIdx = data.length - 1; }
  const origData = data.slice();
  destroy(name);
  charts[name] = new Chart($(canvas), {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: bg, borderWidth: 2, borderColor: "#fff" }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "58%",
      plugins: {
        legend: {
          position: "right", labels: { font: { size: 11 }, boxWidth: 12, padding: 7 },
          onClick: (e, item, legend) => {
            const ci = legend.chart, idx = item.index;
            ci.toggleDataVisibility(idx);
            if (othersIdx >= 0 && idx !== othersIdx) {
              let extra = 0;
              for (let i = 0; i < origData.length; i++) if (i !== othersIdx && ci.getDataVisibility(i) === false) extra += origData[i];
              ci.data.datasets[0].data[othersIdx] = origData[othersIdx] + extra;
            }
            ci.update();
          },
        },
        tooltip: { callbacks: { label: (c) => { const total = c.dataset.data.reduce((s, v) => s + v, 0) || 1; return " " + c.label + ": " + fmt(c.parsed) + " (" + (c.parsed / total * 100).toFixed(1) + "%)"; } } },
      },
    },
  });
}

function renderRegionsTable() {
  const q = $("tableFilter").value.trim().toLowerCase();
  const tbody = $("regionsTable").querySelector("tbody");
  tbody.innerHTML = "";
  state.regions.filter((r) => !q || r.name.toLowerCase().includes(q)).forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="num">${i + 1}</td><td>${r.name}</td>` +
      `<td class="num">${fmt(r.market)}</td>` +
      `<td class="num tag-otp">${fmt(r.otp)}</td>` +
      `<td class="num"><span class="tag-pen">${fmtPct(r.penetration)}</span></td>` +
      `<td class="num">${Math.round(r.affinityIndex || 0)}</td>`;
    tbody.appendChild(tr);
  });
}

function populateRegionSelect() {
  const sel = $("dynRegion");
  const prev = sel.value;
  sel.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "ALL"; optAll.textContent = "Все регионы РФ"; sel.appendChild(optAll);
  state.subjects.forEach((s) => { const o = document.createElement("option"); o.value = s.id; o.textContent = s.name; sel.appendChild(o); });
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : "ALL";
}

async function onExport() {
  const btn = $("exportBtn");
  btn.disabled = true; const label = btn.textContent; btn.textContent = "…";
  try {
    const resp = await fetch("/api/export", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phrase: state.marketPhrase, otpPhrase: state.otpPhrase, regions: state.regions, dynamics: state.hist }),
    });
    if (!resp.ok) throw new Error("Не удалось сформировать файл");
    const blob = await resp.blob(), url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "wordstat_" + (state.marketPhrase || "export").replace(/\s+/g, "_") + ".xlsx";
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  } catch (err) { showError(err.message); }
  finally { btn.disabled = false; btn.textContent = label; }
}

// --------------------------------------------------------------- helpers --
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
}
function linreg(y) {
  const n = y.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += y[i]; sxx += i * i; sxy += i * y[i]; }
  const d = n * sxx - sx * sx;
  const slope = d ? (n * sxy - sx * sy) / d : 0;
  return { slope, intercept: (sy - slope * sx) / n };
}
function nextMonthLabels(lastKey, k) {
  let y = parseInt(lastKey.slice(0, 4), 10), m = parseInt(lastKey.slice(5, 7), 10);
  const out = [];
  for (let i = 0; i < k; i++) { m++; if (m > 12) { m = 1; y++; } out.push(MONTH_ABBR[m - 1] + " " + y); }
  return out;
}
function shortNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".0", "") + " млн";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(".0", "") + " тыс";
  return String(Math.round(n));
}
function niceStep(raw) {
  if (raw <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
function buildHistogram(counts) {
  if (!counts.length) return { labels: [], data: [] };
  const max = Math.max(...counts), step = niceStep(max / 8) || 1;
  const bins = Math.max(1, Math.ceil((max + 1) / step)), data = new Array(bins).fill(0);
  counts.forEach((c) => { let i = Math.floor(c / step); if (i >= bins) i = bins - 1; data[i]++; });
  return { labels: data.map((_, i) => shortNum(i * step) + "–" + shortNum((i + 1) * step)), data };
}
function showError(msg) {
  const el = $("error");
  if (!msg) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.textContent = msg; el.classList.remove("hidden");
}
