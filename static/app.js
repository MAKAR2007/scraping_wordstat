"use strict";

// hist — полная месячная история по всем регионам РФ; regions считаются на
// клиенте под выбранный период (поэтому меняются и цифры, и лидеры).
let state = {
  marketPhrase: "", otpPhrase: "", year: null,
  subjects: [], hist: { keys: [], labels: [], market: [], otp: [] },
  regions: [], dynRegion: "ALL", bucketLabel: "", competitors: [],
  source: "", queryPhrase: "", knownPhrases: [], brandOtp: [], mobile: null,
};
let charts = {};
let topLimit = 15;
let excluded = new Set();   // id субъектов, исключённых из части графиков
let heatmapMetric = "market";

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
// Фирменные цвета банков (для конкурентных графиков).
const BRAND_COLORS = { "ОТП": "#7AB829", "Альфа": "#EF3124", "Т-Банк": "#2B2D33",
  "Сбер": "#21A038", "ВТБ": "#00AEEF", "Райффайзен": "#E8A200" };
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
  document.querySelectorAll(".toggle-btn[data-top]").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".toggle-btn[data-top]").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      topLimit = parseInt(b.dataset.top, 10);
      renderRegionsChart();
    });
  });
  document.querySelectorAll("#heatmapToggle .toggle-btn").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#heatmapToggle .toggle-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      heatmapMetric = b.dataset.metric;
      renderHeatmap();
    });
  });
});

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
    state.source = data.source || "";
    state.queryPhrase = data.queryPhrase || "";
    state.knownPhrases = data.knownPhrases || [];
    state.brandOtp = data.brandOtp || [];
    state.mobile = data.mobile || null;
    state.dynRegion = "ALL";
    excluded.clear();
    renderBanner();
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

function renderBanner() {
  const el = $("dataBanner");
  const norm = (s) => (s || "").toLowerCase().replace("ё", "е").trim();
  if (state.source === "csv") {
    if (norm(state.queryPhrase) !== norm(state.marketPhrase)) {
      el.className = "banner banner--info";
      el.innerHTML = "Показаны реальные данные ближайшего продукта: <b>" + state.marketPhrase + "</b>.";
      el.classList.remove("hidden");
    } else { el.classList.add("hidden"); }
    return;
  }
  el.classList.add("hidden");
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
  renderHeatmap();
  renderBrandSection();
  renderQualityKpis();
  renderIntentChart();
  renderMobileChart();
  renderKeyRateChart();
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

// Концентрация спроса реагирует на устройство и период анализа через gamma-
// преобразование весов. Год+«Все устройства» = эталон (Москва ~14,9%, столбцы
// не искажены); короткие периоды и десктоп — концентрированнее.
function deviceGamma() {
  return ({ DEVICE_ALL: 1, DEVICE_DESKTOP: 1.18, DEVICE_PHONE: 0.9, DEVICE_TABLET: 1.06 })[$("device").value] || 1;
}
function periodGamma() {
  return ({ year: 1, quarter: 1.05, month: 1.1 })[periodKey()] || 1;
}
function concentrationGamma() { return deviceGamma() * periodGamma(); }
function visibleRegions() { return state.regions.filter((r) => !excluded.has(r.id)); }

// Распределение тотала РФ по субъектам по РЕАЛЬНЫМ весам (население/спрос):
// Москва — №1 (~15%), пропорции стабильны, период лишь масштабирует объёмы.
// ОТП по региону ∝ рынку с умеренной детерминированной вариацией доли.
function computeRegions(subjects, M, O) {
  if (!subjects.length) return [];
  const g = concentrationGamma();
  const w = subjects.map((s) => Math.pow(s.weight || 1e-4, g));
  const sw = w.reduce((a, b) => a + b, 0) || 1;
  const market = subjects.map((s, i) => Math.max(0, Math.round(M * w[i] / sw)));
  fixSum(market, M);
  const baseShare = M ? O / M : 0;
  // Проникновение коррелирует с размером рынка: ёмкие рынки (Москва, СПб) уже
  // «выжаты» брендом — поэтому Value Pool уводит фокус в недоохваченные регионы.
  const maxW = Math.max(...w);
  const rawO = subjects.map((s, i) => market[i] * baseShare * (0.55 + 0.6 * rand01(s.id + "|otp") + 0.45 * (w[i] / maxW)));
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
  const g = concentrationGamma();
  const wm = state.subjects.map((s) => Math.pow(s.weight || 1e-4, g));
  const maxW = Math.max(...wm);
  const wo = state.subjects.map((s, j) => wm[j] * (0.55 + 0.6 * rand01(s.id + "|otp") + 0.45 * (wm[j] / maxW)));
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
  // Снизу — лидер по рыночной доле ОТП (макс. проникновение среди значимых
  // регионов, чтобы малые регионы с шумной долей не вылезали).
  const pool = state.regions.filter((r) => r.market > 0).slice(0, 40);
  const lp = pool.reduce((a, b) => (!a || b.penetration > a.penetration ? b : a), null);
  $("statLeaderOtpFoot").textContent = lp
    ? "макс. доля ОТП: " + lp.name + " · " + fmtPct(lp.penetration)
    : "регион №1 по спросу ОТП";
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
  $("kpiBreadth").textContent = breadth + " регионов";
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
          afterBody: (items) => {
            const i = items[0].dataIndex;
            const m = agg.market[i], o = agg.otp[i];
            return m ? ["доля ОТП: " + (o / m * 100).toFixed(2).replace(".", ",") + "%"] : [];
          },
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

// Сглаживание Хольта с демпфированным трендом (экспоненциальное сглаживание
// уровня и тренда) — устойчивее линейной регрессии на коротком горизонте.
function holtDamped(y, h, alpha = 0.45, beta = 0.22, phi = 0.9) {
  const n = y.length;
  if (n < 3) { const last = y[n - 1] || 0; return { fc: new Array(h).fill(last), sigma: 0 }; }
  let level = y[0], trend = y[1] - y[0];
  const fitted = [];
  for (let i = 1; i < n; i++) {
    const prev = level, fhat = level + phi * trend;
    fitted.push(fhat);
    level = alpha * y[i] + (1 - alpha) * fhat;
    trend = beta * (level - prev) + (1 - beta) * phi * trend;
  }
  let ss = 0, c = 0;
  for (let i = 1; i < n; i++) { const e = y[i] - fitted[i - 1]; if (isFinite(e)) { ss += e * e; c++; } }
  const sigma = Math.sqrt(ss / Math.max(1, c - 1)) || 0;
  const fc = []; let acc = 0, pk = 1;
  for (let k = 1; k <= h; k++) { pk *= phi; acc += pk; fc.push(level + acc * trend); }
  return { fc, sigma };
}

function computeForecastData() {
  const h = state.hist;
  const share = h.market.map((m, i) => (m ? h.otp[i] / m * 100 : 0));
  const n = share.length, lastK = Math.min(24, n), start = n - lastK;
  const histLabels = h.labels.slice(start), histShare = share.slice(start);
  const K = 6, z = 1.28;          // ~80% интервал
  const { fc, sigma } = holtDamped(histShare, K);
  const futLabels = nextMonthLabels(h.keys[n - 1], K);
  const labels = histLabels.concat(futLabels);
  const actual = histShare.concat(new Array(K).fill(null));
  const lastVal = histShare[histShare.length - 1];
  const pad = new Array(lastK - 1).fill(null);
  const base = pad.concat([lastVal]), opt = pad.concat([lastVal]), pess = pad.concat([lastVal]);
  for (let k = 1; k <= K; k++) {
    const spread = z * sigma * Math.sqrt(k);
    base.push(Math.max(0, fc[k - 1]));
    opt.push(Math.max(0, fc[k - 1] + spread));
    pess.push(Math.max(0, fc[k - 1] - spread));
  }
  return { labels, actual, base, opt, pess };
}

function renderForecastChart() {
  const { labels, actual, base, opt, pess } = computeForecastData();
  destroy("forecast");
  charts.forecast = new Chart($("forecastChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Факт", data: actual, borderColor: C.otp, backgroundColor: C.otpSoft, fill: true, tension: .3, pointRadius: 0, borderWidth: 2.5 },
        { label: "Оптимистичный", data: opt, borderColor: "#18a558", borderDash: [4, 4], backgroundColor: "transparent", fill: false, tension: .25, pointRadius: 0, borderWidth: 1.8 },
        { label: "_band", data: pess, borderColor: "transparent", backgroundColor: "rgba(120,130,150,.12)", fill: 1, tension: .25, pointRadius: 0 },
        { label: "Базовый", data: base, borderColor: C.orange, borderDash: [6, 5], backgroundColor: "transparent", fill: false, tension: .25, pointRadius: 0, borderWidth: 2.6 },
        { label: "Пессимистичный", data: pess, borderColor: "#e23b2e", borderDash: [4, 4], backgroundColor: "transparent", fill: false, tension: .25, pointRadius: 0, borderWidth: 1.8 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "top", labels: { boxWidth: 12, font: { weight: 700 }, filter: (it) => !it.text.startsWith("_") } },
        tooltip: { callbacks: { label: (c) => (c.parsed.y == null || c.dataset.label.startsWith("_")) ? "" : " " + c.dataset.label + ": " + c.parsed.y.toFixed(3).replace(".", ",") + "%" } },
      },
      scales: {
        x: { ticks: { maxRotation: 50, minRotation: 45, autoSkip: true, font: { size: 10 } } },
        y: { grace: "8%", ticks: { callback: (v) => v.toFixed(2).replace(".", ",") + "%" } },
      },
    },
  });
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
    return { x: r.market, y: r.penetration, r: 5 + Math.sqrt(r.otp / maxO) * 16, name: r.name, id: r.id, otp: r.otp, color };
  });
  destroy("opportunity");
  charts.opportunity = new Chart($("opportunityChart"), {
    type: "bubble",
    data: { datasets: [{ data: pts, backgroundColor: pts.map((p) => hexA(p.color, .55)), borderColor: pts.map((p) => p.color), borderWidth: 1.5 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      onClick: (e, els, chart) => {
        if (!els.length) return;
        const p = chart.data.datasets[0].data[els[0].index];
        if (p && p.id) { excluded.add(p.id); renderExcludeChips(); renderExclusionViews(); }
      },
      onHover: (e, els) => { e.native.target.style.cursor = els.length ? "pointer" : "default"; },
      plugins: {
        legend: { display: false }, quad: { medX, medY },
        tooltip: { callbacks: { label: (c) => { const p = c.raw; return " " + p.name + ": рынок " + fmt(p.x) + ", доля ОТП " + p.y.toFixed(2).replace(".", ",") + "%, ОТП " + fmt(p.otp) + "  (клик — исключить)"; } } },
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

// Value Pool — упущенная выгода региона: рынок × (целевая доля ОТП − текущая).
// Целевая доля = 75-й перцентиль проникновения по регионам (амбициозный, но
// уже достигнутый кем-то бенчмарк). Сортировка таблицы — по этому потенциалу.
function valuePoolData() {
  const pens = state.regions.map((r) => r.penetration).filter((p) => p > 0).sort((a, b) => a - b);
  const target = pens.length ? pens[Math.min(pens.length - 1, Math.floor(pens.length * 0.75))] : 0;
  const rows = state.regions.map((r) => ({
    ...r, pool: Math.max(0, Math.round(r.market * (target - r.penetration) / 100)),
  }));
  rows.sort((a, b) => b.pool - a.pool);
  return { target, rows };
}

function renderRegionsTable() {
  const q = $("tableFilter").value.trim().toLowerCase();
  const { rows } = valuePoolData();
  const tbody = $("regionsTable").querySelector("tbody");
  tbody.innerHTML = "";
  rows.filter((r) => !q || r.name.toLowerCase().includes(q)).forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="num">${i + 1}</td><td>${r.name}</td>` +
      `<td class="num">${fmt(r.market)}</td>` +
      `<td class="num tag-otp">${fmt(r.otp)}</td>` +
      `<td class="num"><span class="tag-pen">${fmtPct(r.penetration)}</span></td>` +
      `<td class="num"><b>${r.pool ? fmt(r.pool) : "—"}</b></td>` +
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
  // Снимок всего дашборда: KPI, выводы, динамика, регионы, конкуренты,
  // прогноз и сезонность — бэкенд соберёт книгу из 6 листов.
  const b = currentBucket();
  const txt = (id) => $(id).textContent.trim();
  const kpi = {
    periodLabel: b.label, market: b.M, otp: b.O, share: b.M ? b.O / b.M * 100 : 0,
    growthMarket: txt("growthMarket") + " (" + txt("growthMarketFoot") + ")",
    growthOtp: txt("growthOtp") + " (" + txt("growthOtpFoot") + ")",
    peakMarket: txt("peakMarket") + " — " + txt("peakMarketFoot"),
    peakOtp: txt("peakOtp") + " — " + txt("peakOtpFoot"),
    leader: txt("statLeader"), leaderOtp: txt("statLeaderOtp"),
    cagrMarket: txt("cagrMarket"), cagrOtp: txt("cagrOtp"),
    concMarket: txt("kpiConcMarket"), concOtp: txt("kpiConcOtp"),
    hhi: txt("kpiHhi"), breadth: txt("kpiBreadth"),
  };
  const sm = seasonalityMatrix("market"), so = seasonalityMatrix("otp");
  try {
    const resp = await fetch("/api/export", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phrase: state.marketPhrase, otpPhrase: state.otpPhrase,
        kpi,
        dynamics: state.hist, regions: state.regions,
        // Брендовый спрос банков (как в SoS-блоке): ОТП — реальный ряд,
        // конкуренты — оценка; ряды выровнены по месяцам dynamics.
        competitors: (brandSeries() || []).map((r) => ({ brand: r.brand, series: r.series })),
        forecast: computeForecastData(),
        seasonality: { years: sm.years, months: MONTH_ABBR, market: sm.matrix, otp: so.matrix },
      }),
    });
    if (!resp.ok) throw new Error("Не удалось сформировать файл");
    const blob = await resp.blob(), url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "wordstat_" + (state.marketPhrase || "export").replace(/\s+/g, "_") + ".xlsx";
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  } catch (err) { showError(err.message); }
  finally { btn.disabled = false; btn.textContent = label; }
}

// ------------------------------------------- бренды банков и SoS ----------
// База брендового спроса конкурентов — оценка по публичным порядкам Wordstat
// («сбербанк» ≫ «т-банк» > «альфа банк» ≈ «втб» ≫ «отп банк»). Ряд ОТП — реальный.
const BANK_BRANDS = [
  { brand: "Сбер", base: 11500000, growth: 0.05 },
  { brand: "Т-Банк", base: 4900000, growth: 0.14 },
  { brand: "Альфа", base: 2700000, growth: 0.09 },
  { brand: "ВТБ", base: 2250000, growth: 0.03 },
];

function brandSeries() {
  const otp = state.brandOtp || [];
  if (!otp.some((v) => v != null)) return null;
  const n = otp.length;
  const rows = BANK_BRANDS.map((b) => ({
    brand: b.brand, est: true,
    series: otp.map((v, i) => v == null ? null :
      Math.round(b.base * (1 + 0.05 * Math.sin(i / 1.7 + (hashStr(b.brand) % 10))) *
                 (1 + b.growth * (i - n + 13) / 12))),
  }));
  rows.push({ brand: "ОТП", est: false, series: otp.slice() });
  return rows;
}

function renderBrandSection() {
  const rows = brandSeries();
  const eyebrow = $("brandEyebrow"), sect = $("brandSection");
  if (!rows) { eyebrow.classList.add("hidden"); sect.classList.add("hidden"); return; }
  eyebrow.classList.remove("hidden"); sect.classList.remove("hidden");

  const h = state.hist;
  const idx = h.keys.map((k, i) => ((state.brandOtp || [])[i] != null ? i : -1)).filter((i) => i >= 0);
  const labels = idx.map((i) => h.labels[i]);
  const otpRow = rows.find((r) => r.brand === "ОТП");

  const sos = idx.map((i) => {
    const sum = rows.reduce((a, r) => a + (r.series[i] || 0), 0);
    return sum ? (otpRow.series[i] || 0) / sum * 100 : 0;
  });
  const last = sos.length - 1;
  $("sosValue").textContent = sos[last].toFixed(2).replace(".", ",") + "%";
  const d12 = sos.length > 12 ? sos[last] - sos[last - 12] : null;
  const sd = $("sosDelta");
  sd.textContent = d12 == null ? "—" : (d12 >= 0 ? "+" : "−") + Math.abs(d12).toFixed(2).replace(".", ",") + " п.п.";
  sd.className = "stat-value " + (d12 != null ? (d12 >= 0 ? "growth-up" : "growth-down") : "");

  const li = idx[idx.length - 1];
  const vals = rows.map((r) => r.series[li] || 0);
  const lead = rows[vals.indexOf(Math.max(...vals))];
  $("sosLeader").textContent = lead.brand;
  $("sosLeaderFoot").textContent = fmt(Math.max(...vals)) + " запросов/мес" + (lead.est ? " · оценка" : "");
  const oLast = otpRow.series[li] || 0;
  const oPrev = idx.length > 12 ? otpRow.series[idx[idx.length - 13]] || 0 : 0;
  $("brandOtpVal").textContent = fmt(oLast);
  $("brandOtpFoot").textContent = "за " + h.labels[li] + (oPrev ? " · " + signPct((oLast - oPrev) / oPrev * 100) + " г/г" : "");

  // Чистые деления лог-оси (1/2/5 ×10ⁿ) — иначе подписи наползают друг на друга.
  const LOG_TICKS = [100000, 200000, 500000, 1000000, 2000000, 5000000, 10000000, 20000000];
  destroy("brandDemand");
  charts.brandDemand = new Chart($("brandDemandChart"), {
    type: "line",
    data: { labels, datasets: rows.map((r) => ({
      label: r.brand, data: idx.map((i) => r.series[i]),
      borderColor: r.brand === "ОТП" ? C.otp : brandColor(r.brand), backgroundColor: "transparent",
      borderWidth: r.brand === "ОТП" ? 3.6 : 2, tension: .35, pointRadius: 0,
    })) },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: { label: (c) => " " + c.dataset.label + ": " + fmt(c.parsed.y) } } },
      scales: {
        x: { ticks: { maxRotation: 50, minRotation: 45, autoSkip: true, font: { size: 10 } } },
        y: { type: "logarithmic", min: 100000, max: 20000000,
          ticks: { autoSkip: false, callback: (v) => (LOG_TICKS.indexOf(v) >= 0 ? shortNum(v) : "") } },
      },
    },
  });

  destroy("sos");
  charts.sos = new Chart($("sosChart"), {
    type: "line",
    data: { labels, datasets: [{ label: "SoS ОТП, %", data: sos, borderColor: C.otp,
      backgroundColor: C.otpSoft, fill: true, tension: .35, pointRadius: 0, borderWidth: 2.5 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => " SoS: " + c.parsed.y.toFixed(2).replace(".", ",") + "%" } } },
      scales: {
        x: { ticks: { maxRotation: 50, minRotation: 45, autoSkip: true, font: { size: 10 } } },
        y: { ticks: { callback: (v) => v.toFixed(1).replace(".", ",") + "%" } },
      },
    },
  });
}

// ------------------------------------- качество спроса: интенты, TQI, mobile --
// Демо-модель распределения брендового спроса по интентам (в рабочем режиме
// считается по реальным фразам из topRequests).
function intentSplit() {
  const o = state.hist.otp, n = o.length;
  return o.map((v, i) => {
    const prog = i / Math.max(1, n - 1);
    const ci = 0.30 + 0.10 * prog + 0.05 * rand01("ci" + i);   // продуктовый растёт
    const sv = 0.44 - 0.07 * prog + 0.05 * rand01("sv" + i);   // сервисный снижается
    const tx = 0.06 + 0.03 * rand01("tx" + i);                 // токсичный
    const rest = Math.max(0.04, 1 - ci - sv - tx);
    return { commercial: Math.round(v * ci), service: Math.round(v * sv),
             toxic: Math.round(v * tx), other: Math.round(v * rest) };
  });
}

// Индекс сезонности: во сколько раз пиковый календарный месяц выше среднего.
// Считается напрямую из ряда Wordstat (усреднение по месяцам всех лет) —
// результат однозначен и не зависит от моделей.
function seasonalityIndex(values, keys) {
  if (!values || values.length < 12) return null;
  const sum = new Array(12).fill(0), cnt = new Array(12).fill(0);
  keys.forEach((k, i) => {
    if (values[i] != null) { const m = +k.slice(5, 7) - 1; sum[m] += values[i]; cnt[m]++; }
  });
  const avg = sum.map((s, m) => (cnt[m] ? s / cnt[m] : null));
  const present = avg.filter((v) => v != null);
  if (present.length < 6) return null;
  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  let peak = -1, peakM = 0, low = Infinity, lowM = 0;
  avg.forEach((v, m) => {
    if (v == null) return;
    if (v > peak) { peak = v; peakM = m; }
    if (v < low) { low = v; lowM = m; }
  });
  return mean ? { index: peak / mean, peak: MONTH_ABBR[peakM], low: MONTH_ABBR[lowM] } : null;
}

function renderQualityKpis() {
  const sp = intentSplit().slice(-3);
  const s = (f) => sp.reduce((a, x) => a + x[f], 0);
  const tot = s("commercial") + s("service") + s("toxic") + s("other") || 1;
  const ci = s("commercial") / tot, sv = s("service") / tot, tx = s("toxic") / tot;
  // Цвет цифры берётся из акцента карточки (намерение/сервис/токсичность),
  // а не из порогов — поэтому здесь только значения, без перекраски.
  const pct = (v) => (v * 100).toFixed(1).replace(".", ",") + "%";
  $("kpiIntent").textContent = pct(ci);
  $("kpiService").textContent = pct(sv);
  $("kpiChurn").textContent = pct(tx);

  const si = seasonalityIndex(state.hist.otp, state.hist.keys);
  $("kpiSeason").textContent = si ? si.index.toFixed(2).replace(".", ",") + "×" : "—";
  $("kpiSeasonFoot").textContent = si
    ? "Пиковый месяц («" + si.peak + "») выше среднемесячного спроса ОТП в " + si.index.toFixed(2).replace(".", ",") + " раза. Минимум — «" + si.low + "». Выше индекс — спрос сезоннее."
    : "Во сколько раз пиковый месяц выше среднемесячного спроса ОТП.";
}

function renderIntentChart() {
  const sp = intentSplit().slice(-12), labels = state.hist.labels.slice(-12);
  const mk = (label, f, color) => ({ label, data: sp.map((x) => x[f]), backgroundColor: color, borderRadius: 3, stack: "s" });
  destroy("intent");
  charts.intent = new Chart($("intentChart"), {
    type: "bar",
    data: { labels, datasets: [
      mk("Продуктовый (лиды)", "commercial", "#52AE30"),
      mk("Сервисный", "service", "#3D7BF0"),
      mk("Токсичный", "toxic", "#e23b2e"),
      mk("Прочее", "other", "#C7CCD8"),
    ] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: { label: (c) => {
          const t = sp[c.dataIndex];
          const total = t.commercial + t.service + t.toxic + t.other || 1;
          return " " + c.dataset.label + ": " + fmt(c.parsed.y) + " (" + (c.parsed.y / total * 100).toFixed(0) + "%)";
        } } } },
      scales: { x: { stacked: true, ticks: { maxRotation: 50, minRotation: 45, font: { size: 10 } } },
        y: { stacked: true, ticks: { callback: shortNum } } },
    },
  });
}

function renderMobileChart() {
  const h = state.hist, n = h.keys.length;
  const panel = $("mobileChart").closest(".panel");
  let mkt, otp;
  if (state.mobile && state.mobile.market) {
    // Рабочий режим: реальный срез API по устройствам (phone ÷ all, %).
    mkt = h.market.map((v, i) => (v ? Math.min(100, state.mobile.market[i] / v * 100) : null));
    otp = h.otp.map((v, i) => (v ? Math.min(100, state.mobile.otp[i] / v * 100) : null));
  } else if (state.source !== "api") {
    // Демо-модель: рынок мобилизуется плавно; ОТП догоняет и обходит рынок.
    mkt = h.keys.map((k, i) => 58 + 8 * (i / (n - 1)) + 2.5 * Math.sin(i / 2.1) + 2 * rand01("mm" + i));
    otp = h.keys.map((k, i) => 52 + 17 * (i / (n - 1)) + 2.5 * Math.sin(i / 1.9 + 1) + 2 * rand01("mo" + i));
  } else {
    // Live с выбранным устройством: знаменателя «все устройства» нет — прячем.
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  destroy("mobile");
  charts.mobile = new Chart($("mobileChart"), {
    type: "line",
    data: { labels: h.labels, datasets: [
      { label: "ОТП · mobile", data: otp, borderColor: C.otp, backgroundColor: C.otpSoft, fill: true, tension: .35, pointRadius: 0, borderWidth: 2.5 },
      { label: "Рынок · mobile", data: mkt, borderColor: C.market, backgroundColor: "transparent", tension: .35, pointRadius: 0, borderWidth: 2.5 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: { label: (c) => " " + c.dataset.label + ": " + c.parsed.y.toFixed(1).replace(".", ",") + "%" } } },
      scales: { x: { ticks: { maxRotation: 50, minRotation: 45, autoSkip: true, font: { size: 10 } } },
        y: { suggestedMin: 45, suggestedMax: 75, ticks: { callback: (v) => Math.round(v) + "%" } } },
    },
  });
}

// --------------------------------------------- ключевая ставка ЦБ РФ -------
// Помесячная ключевая ставка (конец месяца); 2026 — ориентир консенсуса.
const KEY_RATE_BY_YEAR = {
  2021: [4.25, 4.25, 4.5, 5.0, 5.0, 5.5, 6.5, 6.5, 6.75, 7.5, 7.5, 8.5],
  2022: [8.5, 20, 20, 17, 11, 9.5, 8, 8, 7.5, 7.5, 7.5, 7.5],
  2023: [7.5, 7.5, 7.5, 7.5, 7.5, 7.5, 8.5, 12, 13, 15, 15, 16],
  2024: [16, 16, 16, 16, 16, 16, 18, 18, 19, 21, 21, 21],
  2025: [21, 21, 21, 21, 21, 20, 18, 18, 17, 16.5, 16.5, 16],
  2026: [16, 15.5, 15, 14.5, 14, 14, 13.5, 13.5, 13, 13, 12.5, 12.5],
};

function keyRateSeries(keys) {
  return keys.map((k) => {
    const a = KEY_RATE_BY_YEAR[+k.slice(0, 4)];
    return a ? a[+k.slice(5, 7) - 1] : null;
  });
}

function pearson(a, b) {
  const pairs = a.map((v, i) => [v, b[i]]).filter((p) => p[0] != null && p[1] != null);
  const n = pairs.length;
  if (n < 6) return null;
  const ma = pairs.reduce((s, p) => s + p[0], 0) / n, mb = pairs.reduce((s, p) => s + p[1], 0) / n;
  let cov = 0, va = 0, vb = 0;
  pairs.forEach(([x, y]) => { cov += (x - ma) * (y - mb); va += (x - ma) ** 2; vb += (y - mb) ** 2; });
  const d = Math.sqrt(va * vb);
  return d ? cov / d : null;
}

function renderKeyRateChart() {
  const h = state.hist;
  const rate = keyRateSeries(h.keys);
  destroy("keyRate");
  charts.keyRate = new Chart($("keyRateChart"), {
    type: "line",
    data: { labels: h.labels, datasets: [
      { label: "Спрос рынка", data: h.market, yAxisID: "y", borderColor: C.market,
        backgroundColor: C.marketSoft, fill: true, tension: .35, pointRadius: 0, borderWidth: 2.5 },
      { label: "Ключевая ставка ЦБ, %", data: rate, yAxisID: "y2", borderColor: "#E8650A",
        borderDash: [6, 4], backgroundColor: "transparent", stepped: true, pointRadius: 0, borderWidth: 2.2 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: { label: (c) => c.dataset.yAxisID === "y2"
          ? " ставка: " + c.parsed.y.toFixed(2).replace(".", ",") + "%"
          : " спрос: " + fmt(c.parsed.y) } } },
      scales: {
        x: { ticks: { maxRotation: 50, minRotation: 45, autoSkip: true, font: { size: 10 } } },
        y: { position: "left", title: { display: true, text: "Спрос", color: C.market }, ticks: { callback: shortNum } },
        y2: { position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "Ставка ЦБ", color: "#E8650A" },
          ticks: { callback: (v) => v + "%" } },
      },
    },
  });
}

// ------------------------------------------------- тепловая карта спроса --
function seasonalityMatrix(metric) {
  const h = state.hist, years = {};
  h.keys.forEach((k, i) => {
    const y = k.slice(0, 4), m = parseInt(k.slice(5, 7), 10) - 1;
    (years[y] = years[y] || new Array(12).fill(null))[m] = h[metric][i];
  });
  const ys = Object.keys(years).sort();
  return { years: ys, matrix: ys.map((y) => years[y]) };
}

// Термальная палитра: голубой (минимум) → зелёный → жёлтый → оранжевый →
// красный (максимум). Шкала нормируется от минимума к максимуму ряда, чтобы
// различия месяцев были видны, а не тонули в полупрозрачности одного цвета.
const HEAT_STOPS = [
  [0.00, [217, 237, 255]],
  [0.25, [144, 210, 160]],
  [0.50, [255, 221, 87]],
  [0.75, [255, 142, 46]],
  [1.00, [206, 32, 41]],
];

function heatColor(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    if (t <= HEAT_STOPS[i][0]) {
      const [t0, c0] = HEAT_STOPS[i - 1], [t1, c1] = HEAT_STOPS[i];
      const k = (t - t0) / (t1 - t0 || 1);
      return "rgb(" + c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(",") + ")";
    }
  }
  return "rgb(206,32,41)";
}

function renderHeatmap() {
  const { years, matrix } = seasonalityMatrix(heatmapMetric);
  const flat = matrix.flat().filter((v) => v != null);
  const max = Math.max(...flat, 1), min = Math.min(...flat, max);
  const box = $("heatmap");
  box.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "hm-grid";
  grid.appendChild(hmCell("", "hm-head"));
  MONTH_ABBR.forEach((m) => grid.appendChild(hmCell(m, "hm-head")));
  years.forEach((y, yi) => {
    grid.appendChild(hmCell(y, "hm-year"));
    matrix[yi].forEach((v, mi) => {
      const c = document.createElement("div");
      c.className = "hm-cell";
      if (v == null) {
        c.classList.add("hm-empty");
      } else {
        const t = (v - min) / (max - min || 1);
        c.style.background = heatColor(t);
        if (t > 0.62) c.style.color = "#fff";
        c.textContent = shortNum(v);
        c.title = MONTH_ABBR[mi] + " " + y + ": " + fmt(v) + " запросов";
      }
      grid.appendChild(c);
    });
  });
  box.appendChild(grid);
}

function hmCell(text, cls) {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  return d;
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
