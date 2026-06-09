"use strict";

// hist — полная месячная история по всем регионам РФ; regions считаются на
// клиенте под выбранный период (поэтому меняются и цифры, и лидеры).
let state = {
  marketPhrase: "", otpPhrase: "", year: null,
  subjects: [], hist: { keys: [], labels: [], market: [], otp: [] },
  regions: [], dynRegion: "ALL", bucketLabel: "", competitors: [],
};
let charts = {};
let topLimit = 15;
let excluded = new Set();   // id субъектов, исключённых из части графиков

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
// Различимые цвета по годам (для сезонности) и категориальная палитра (15).
const YEAR_COLORS = ["#3D7BF0", "#21A36B", "#FF7A1A", "#E8467C", "#6C4CF1", "#F5B301"];
const CAT_COLORS = ["#6C4CF1", "#7AB829", "#FF7A1A", "#22B8CF", "#E8467C",
  "#F5B301", "#2F9E6E", "#9B5DE5", "#3D7BF0", "#FF6B6B", "#12B886", "#FA5252",
  "#4C6EF5", "#BE4BDB", "#FD7E14"];
const BRAND_COLORS = { "ОТП": "#6C4CF1", "Альфа": "#EF3124", "Т-Банк": "#111827", "Сбер": "#21A038", "Райффайзен": "#E8A200" };
const brandColor = (b) => BRAND_COLORS[b] || CAT_COLORS[(hashStr(b) % CAT_COLORS.length)];
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
  $("excludeSelect").addEventListener("change", (e) => {
    const id = e.target.value;
    if (id) { excluded.add(id); e.target.value = ""; renderExcludeChips(); renderExclusionViews(); }
  });
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
    state.competitors = data.competitors || [];
    state.hist = data.dynamics || { keys: [], labels: [], market: [], otp: [] };
    state.dynRegion = "ALL";
    excluded.clear();
    populateRegionSelect();
    renderExcludeChips();
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
  renderCompetition();
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

// Концентрация спроса по устройству: десктоп смещён в столицы (выше gamma →
// концентрированнее), мобайл более распределён. Делает концентрацию реактивной.
function deviceGamma() {
  return ({ DEVICE_ALL: 1, DEVICE_DESKTOP: 1.18, DEVICE_PHONE: 0.9, DEVICE_TABLET: 1.06 })[$("device").value] || 1;
}
function visibleRegions() { return state.regions.filter((r) => !excluded.has(r.id)); }

// Распределение тотала РФ по субъектам по РЕАЛЬНЫМ весам (население/спрос):
// Москва — №1 (~15%), пропорции стабильны, период лишь масштабирует объёмы.
// ОТП по региону ∝ рынку с умеренной детерминированной вариацией доли.
function computeRegions(subjects, M, O) {
  if (!subjects.length) return [];
  const g = deviceGamma();
  const w = subjects.map((s) => Math.pow(s.weight || 1e-4, g));
  const sw = w.reduce((a, b) => a + b, 0) || 1;
  const market = subjects.map((s, i) => Math.max(0, Math.round(M * w[i] / sw)));
  fixSum(market, M);
  const baseShare = M ? O / M : 0;
  const rawO = subjects.map((s, i) => market[i] * baseShare * (0.65 + 0.7 * rand01(s.id + "|otp")));
  const so = rawO.reduce((a, b) => a + b, 0) || 1;
  const otp = subjects.map((s, i) => Math.min(market[i], Math.max(0, Math.round(rawO[i] * O / so))));
  fixSumClamped(otp, O, market);
  return subjects.map((s, i) => ({
    id: s.id, name: s.name, market: market[i], otp: otp[i],
    penetration: market[i] ? +(otp[i] / market[i] * 100).toFixed(3) : 0,
    marketShare: M ? +(market[i] / M * 100).toFixed(2) : 0,
    otpShare: O ? +(otp[i] / O * 100).toFixed(2) : 0,
    affinityIndex: 50 + (hashStr(s.id + "|a") % 120),
  })).sort((a, b) => b.market - a.market);
}

function recomputeRegions() {
  const b = currentBucket();
  state.bucketLabel = b.label;
  state.regions = computeRegions(state.subjects, b.M, b.O);
}

function regionFractions(regionId) {
  const i = state.subjects.findIndex((s) => s.id === regionId);
  if (i < 0) return { fm: 1, fo: 1 };
  const g = deviceGamma();
  const wm = state.subjects.map((s) => Math.pow(s.weight || 1e-4, g));
  const wo = state.subjects.map((s, j) => wm[j] * (0.65 + 0.7 * rand01(s.id + "|otp")));
  const swm = wm.reduce((a, b) => a + b, 0) || 1, swo = wo.reduce((a, b) => a + b, 0) || 1;
  return { fm: wm[i] / swm, fo: wo[i] / swo };
}

function scaleHist(h, fm, fo) {
  return { keys: h.keys, labels: h.labels, market: h.market.map((v) => Math.round(v * fm)), otp: h.otp.map((v) => Math.round(v * fo)) };
}

function currentDynHist() {
  if (state.dynRegion !== "ALL") {
    const { fm, fo } = regionFractions(state.dynRegion);
    return scaleHist(state.hist, fm, fo);
  }
  if (excluded.size) {
    const totM = state.regions.reduce((a, r) => a + r.market, 0) || 1;
    const totO = state.regions.reduce((a, r) => a + r.otp, 0) || 1;
    const vis = visibleRegions();
    const visM = vis.reduce((a, r) => a + r.market, 0), visO = vis.reduce((a, r) => a + r.otp, 0);
    return scaleHist(state.hist, visM / totM, visO / totO);
  }
  return state.hist;
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
    return { label: hidx >= 0 ? b.agg.labels[hidx] : "—", val: hi > 0 ? hi : 0, idx: hidx };
  };
  const unit = periodUnit(), pm = peak("market"), po = peak("otp");
  $("peakMarket").textContent = fmt(pm.val);
  $("peakMarketFoot").textContent = "максимум · " + pm.label;
  const poShare = (po.idx >= 0 && b.agg.market[po.idx]) ? b.agg.otp[po.idx] / b.agg.market[po.idx] * 100 : 0;
  $("peakOtp").textContent = fmt(po.val);
  $("peakOtpFoot").textContent = "максимум · " + po.label + " · доля рынка " + poShare.toFixed(2).replace(".", ",") + "%";
}

function renderStrategicKpis() {
  // CAGR выносим в подпись к динамике частоты (а не отдельными цифрами).
  const ya = aggregate(state.hist, "year");
  const full = [];
  for (let i = 0; i < ya.counts.length; i++) if (ya.counts[i] >= 12) full.push(i);
  const cagr = (arr) => {
    if (full.length < 2) return null;
    const a = arr[full[0]], b = arr[full[full.length - 1]], yrs = full.length - 1;
    if (a <= 0 || yrs <= 0) return null;
    return (Math.pow(b / a, 1 / yrs) - 1) * 100;
  };
  const cm = cagr(ya.market), co = cagr(ya.otp);
  const setBadge = (id, v) => {
    const el = $(id);
    if (v == null) { el.textContent = "—"; el.className = "cagr-badge"; return; }
    el.textContent = signPct(v); el.className = "cagr-badge " + (v >= 0 ? "is-up" : "is-down");
  };
  setBadge("cagrMarket", cm); setBadge("cagrOtp", co);

  // Концентрация спроса (реактивна к устройству через веса).
  const pctTxt = (v) => v.toFixed(1).replace(".", ",") + "%";
  const sm = [...state.regions].sort((a, b) => b.market - a.market);
  const totM = sm.reduce((a, r) => a + r.market, 0) || 1;
  const top5m = sm.slice(0, 5).reduce((a, r) => a + r.market, 0);
  const so = [...state.regions].sort((a, b) => b.otp - a.otp);
  const totO = so.reduce((a, r) => a + r.otp, 0) || 1;
  const top5o = so.slice(0, 5).reduce((a, r) => a + r.otp, 0);
  const hhi = Math.round(sm.reduce((a, r) => a + Math.pow(r.market / totM * 100, 2), 0));
  let acc = 0, breadth = 0;
  for (const r of sm) { acc += r.market; breadth++; if (acc >= totM * 0.8) break; }

  $("kpiConcMarket").textContent = pctTxt(top5m / totM * 100);
  $("kpiConcOtp").textContent = pctTxt(top5o / totO * 100);
  $("kpiHhi").textContent = hhi.toLocaleString("ru-RU");
  $("kpiBreadth").textContent = breadth + " рег.";
  $("strategicNote").textContent =
    "Топ-5 регионов формируют " + pctTxt(top5m / totM * 100) + " спроса; 80% спроса дают " + breadth + " субъектов РФ.";
}

// ----------------------------------------------------- регионы: рынок+ОТП --
function destroy(name) { if (charts[name]) { charts[name].destroy(); charts[name] = null; } }

function renderRegionsChart() {
  const rows = visibleRegions().slice(0, topLimit);
  $("regionsChart").parentElement.style.height = Math.max(420, rows.length * 27) + "px";
  destroy("regions");
  charts.regions = new Chart($("regionsChart"), {
    type: "bar",
    data: {
      labels: rows.map((r) => r.name),
      datasets: [
        // У рынка и ОТП разный масштаб (ОТП ~1% рынка), поэтому у ОТП своя
        // верхняя ось — иначе его столбцы не видно.
        { key: "market", label: "Рынок", data: rows.map((r) => r.market), backgroundColor: C.market, xAxisID: "x", borderRadius: 4, categoryPercentage: .74, barPercentage: .9 },
        { key: "otp", label: "ОТП", data: rows.map((r) => r.otp), backgroundColor: C.otp, xAxisID: "x2", borderRadius: 4, categoryPercentage: .74, barPercentage: .9 },
      ],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: { label: (ctx) => {
          const r = rows[ctx.dataIndex];
          return ctx.dataset.key === "market" ? "Рынок: " + fmt(r.market) : "ОТП: " + fmt(r.otp) + " · доля ОТП " + fmtPct(r.penetration);
        } } },
      },
      scales: {
        x: { position: "bottom", title: { display: true, text: "Рынок", color: C.market }, ticks: { callback: shortNum, color: C.market }, grid: { color: "#f1f1f8" } },
        x2: { position: "top", title: { display: true, text: "ОТП", color: C.otp }, ticks: { callback: shortNum, color: C.otp }, grid: { drawOnChartArea: false } },
        y: { ticks: { autoSkip: false, font: { size: 11 } } },
      },
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
  // Доверительный коридор: ±1.5σ остатков тренда (а не «голая» линия).
  let ss = 0; for (let i = 0; i < histShare.length; i++) { const e = histShare[i] - (fit.slope * i + fit.intercept); ss += e * e; }
  const band = 1.5 * Math.sqrt(ss / Math.max(1, histShare.length - 2));
  const K = 6, futLabels = nextMonthLabels(h.keys[n - 1], K);
  const labels = histLabels.concat(futLabels);
  const actual = histShare.concat(new Array(K).fill(null));
  const central = new Array(lastK - 1).fill(null), upper = new Array(lastK - 1).fill(null), lower = new Array(lastK - 1).fill(null);
  const lastVal = histShare[histShare.length - 1];
  central.push(lastVal); upper.push(lastVal); lower.push(lastVal);
  for (let k = 1; k <= K; k++) {
    const c = Math.max(0, fit.slope * (lastK - 1 + k) + fit.intercept);
    central.push(c); upper.push(c + band); lower.push(Math.max(0, c - band));
  }
  destroy("forecast");
  charts.forecast = new Chart($("forecastChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Факт", data: actual, borderColor: C.otp, backgroundColor: C.otpSoft, fill: true, tension: .3, pointRadius: 0, borderWidth: 2.5 },
        { label: "Прогноз", data: central, borderColor: C.orange, borderDash: [6, 5], backgroundColor: "transparent", tension: .2, pointRadius: 0, borderWidth: 2.5 },
        { label: "_upper", data: upper, borderColor: "transparent", pointRadius: 0, fill: false },
        { label: "Коридор ±", data: lower, borderColor: "transparent", pointRadius: 0, backgroundColor: "rgba(255,122,26,.13)", fill: 2, tension: .2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "top", labels: { boxWidth: 12, font: { weight: 700 }, filter: (it) => !it.text.startsWith("_") } },
        tooltip: { callbacks: { label: (c) => (c.parsed.y == null || c.dataset.label.startsWith("_")) ? "" : " " + c.dataset.label + ": " + c.parsed.y.toFixed(2).replace(".", ",") + "%" } },
      },
      scales: { x: { ticks: { maxRotation: 50, minRotation: 45, autoSkip: true, font: { size: 10 } } }, y: { ticks: { callback: (v) => v.toFixed(1).replace(".", ",") + "%" } } },
    },
  });
}

// ----------------------------------------------- конкурентный анализ ------
function aggSeries(series, period) {
  const a = aggregate({ keys: state.hist.keys, labels: state.hist.labels, market: series, otp: series }, period);
  return { labels: a.labels, values: a.market };
}

function renderCompetition() {
  const comp = state.competitors || [];
  const sect = $("competitionSection");
  if (comp.length < 2) { sect.classList.add("hidden"); return; }
  sect.classList.remove("hidden");
  const period = periodKey(), b = currentBucket();
  const labels = aggSeries(comp[0].series, period).labels;

  destroy("compDyn");
  charts.compDyn = new Chart($("compDynChart"), {
    type: "line",
    data: {
      labels,
      datasets: comp.map((c) => ({
        label: c.brand, data: aggSeries(c.series, period).values,
        borderColor: brandColor(c.brand), backgroundColor: "transparent",
        borderWidth: c.isOtp ? 3.2 : 2, tension: .35, pointRadius: 0,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: true, position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: { label: (c) => " " + c.dataset.label + ": " + fmt(c.parsed.y) } } },
      scales: { x: { ticks: { maxRotation: 50, minRotation: 45, autoSkip: true, font: { size: 10 } } }, y: { ticks: { callback: shortNum } } },
    },
  });

  const vals = comp.map((c) => aggSeries(c.series, period).values[b.li] || 0);
  const total = vals.reduce((a, v) => a + v, 0) || 1;
  destroy("compShare");
  charts.compShare = new Chart($("compShareChart"), {
    type: "doughnut",
    data: { labels: comp.map((c) => c.brand), datasets: [{ data: vals, backgroundColor: comp.map((c) => brandColor(c.brand)), borderColor: "#fff", borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "60%",
      plugins: {
        legend: { position: "right", labels: { font: { size: 11 }, boxWidth: 12, padding: 7 } },
        tooltip: { callbacks: { label: (c) => " " + c.label + ": " + fmt(c.parsed) + " (" + (c.parsed / total * 100).toFixed(1) + "%)" } },
      },
    },
  });

  const otpI = comp.findIndex((c) => c.isOtp);
  const leadI = vals.indexOf(Math.max(...vals));
  $("competitionNote").textContent =
    "Доля голоса ОТП среди брендов: " + (vals[otpI] / total * 100).toFixed(1).replace(".", ",") +
    "% (за " + b.label + "). Лидер категории — " + comp[leadI].brand + ".";
}

function renderDistChart() {
  const { labels, data } = buildHistogram(visibleRegions().map((r) => r.market));
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
    data: { labels: rows.map((r) => r.name), datasets: [{ label: "Доля ОТП, %", data: rows.map((r) => r.penetration), backgroundColor: rows.map((_, i) => CAT_COLORS[i % CAT_COLORS.length]), borderRadius: 4 }] },
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
  const recent = Object.keys(years).sort().slice(-6);
  const datasets = recent.map((y, idx) => ({
    label: y, data: years[y], borderColor: YEAR_COLORS[idx % YEAR_COLORS.length], backgroundColor: "transparent",
    tension: .35, pointRadius: 0, spanGaps: true, borderWidth: idx === recent.length - 1 ? 3.2 : 1.8,
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
  const regs = visibleRegions().sort((a, b) => b.market - a.market).slice(0, 40).filter((r) => r.market > 0);
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

  const ex = $("excludeSelect");
  ex.innerHTML = '<option value="">+ исключить регион…</option>';
  state.subjects.forEach((s) => { const o = document.createElement("option"); o.value = s.id; o.textContent = s.name; ex.appendChild(o); });
}

// Исключение регионов влияет на: распределение по регионам, матрицу
// возможностей, гистограмму спроса и агрегатную динамику частоты.
function renderExclusionViews() {
  renderRegionsChart();
  renderOpportunityChart();
  renderDistChart();
  renderDynamicsChart();
}

function renderExcludeChips() {
  const box = $("excludeChips");
  box.innerHTML = "";
  const byId = Object.fromEntries(state.subjects.map((s) => [s.id, s.name]));
  [...excluded].forEach((id) => {
    const chip = document.createElement("button");
    chip.type = "button"; chip.className = "chip";
    chip.innerHTML = byId[id] + ' <span aria-hidden="true">×</span>';
    chip.addEventListener("click", () => { excluded.delete(id); renderExcludeChips(); renderExclusionViews(); });
    box.appendChild(chip);
  });
  box.classList.toggle("hidden", excluded.size === 0);
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
  // Робастный верх: 90-й перцентиль + overflow-бакет, чтобы выбросы (Москва)
  // не «сплющивали» гистограмму влево.
  const sorted = [...counts].sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  const step = niceStep(Math.max(1, p90) / 7) || 1;
  const bins = Math.max(1, Math.round(p90 / step) || 1);
  const data = new Array(bins + 1).fill(0);   // последний бакет — overflow «N+»
  counts.forEach((c) => { let i = Math.floor(c / step); if (i > bins) i = bins; data[i]++; });
  const labels = data.map((_, i) => i < bins ? shortNum(i * step) + "–" + shortNum((i + 1) * step) : shortNum(bins * step) + "+");
  return { labels, data };
}
function showError(msg) {
  const el = $("error");
  if (!msg) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.textContent = msg; el.classList.remove("hidden");
}
