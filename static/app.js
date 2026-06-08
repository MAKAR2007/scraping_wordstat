"use strict";

// Состояние последнего ответа. hist — полная месячная история по всем регионам;
// dynHist — история для графика динамики (может быть по выбранному региону).
let state = {
  marketPhrase: "",
  otpPhrase: "",
  regions: [],
  hist: { keys: [], labels: [], market: [], otp: [] },
  dynHist: { keys: [], labels: [], market: [], otp: [] },
  totals: {},
};
let charts = {
  regions: null, dynamics: null, penetration: null, growthIndex: null,
  dist: null, seasonality: null, shareOtp: null, shareMarket: null,
};
let topLimit = 15;

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n || 0).toLocaleString("ru-RU");
const fmtPct = (v) => {
  v = Number(v) || 0;
  return v.toFixed(v < 1 ? 3 : 2).replace(".", ",") + "%";
};

// Семантика: рынок = салат, ОТП = фиолетовый, акцент = оранжевый.
const C = {
  market: "#7AB829", marketSoft: "rgba(122,184,41,.16)",
  otp: "#6C4CF1", otpSoft: "rgba(108,76,241,.18)",
  orange: "#FF7A1A",
};
// Категориальная палитра — у каждого региона свой различимый цвет.
const PIE_COLORS = ["#6C4CF1", "#7AB829", "#FF7A1A", "#22B8CF", "#E8467C",
  "#F5B301", "#2F9E6E", "#9B5DE5", "#3D7BF0", "#FF6B6B"];
const OTHERS_COLOR = "#C7CCD8";
const SEASON_COLORS = ["#D9CDF6", "#B6A6FB", "#7AB829", "#FF9E45", "#6C4CF1"];
const MONTH_ABBR = ["янв", "фев", "мар", "апр", "май", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек"];

if (window.Chart) {
  Chart.defaults.font.family = "Manrope, -apple-system, Segoe UI, Roboto, sans-serif";
  Chart.defaults.color = "#717787";
}

document.addEventListener("DOMContentLoaded", () => {
  checkStatus();
  $("searchForm").addEventListener("submit", onSearch);
  $("exportBtn").addEventListener("click", onExport);
  $("tableFilter").addEventListener("input", renderRegionsTable);
  $("dynRegion").addEventListener("change", refreshDynamics);
  // Устройства влияют на все данные → полный пересчёт.
  $("device").addEventListener("change", () => {
    if (state.marketPhrase) $("searchForm").requestSubmit();
  });
  // Период — это агрегация уже загруженной истории, без обращения к серверу.
  $("period").addEventListener("change", () => {
    if (state.marketPhrase) { renderDynamicsChart(); renderKpi(); }
  });
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
    if (s.demo) {
      badge.textContent = "демо-режим";
      badge.className = "badge badge--demo";
      badge.title = "Ключ API не задан — показаны демонстрационные данные";
    } else {
      badge.textContent = "рабочий режим";
      badge.className = "badge badge--live";
      badge.title = "Подключён Yandex Wordstat API";
    }
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
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phrase, devices: [$("device").value] }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Ошибка запроса");

    const hist = data.dynamics || { keys: [], labels: [], market: [], otp: [] };
    state = {
      marketPhrase: data.marketPhrase,
      otpPhrase: data.otpPhrase,
      regions: data.regions || [],
      hist,
      dynHist: hist,
      totals: data.totals || {},
    };
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
  const t = state.totals;
  $("statOtpLabel").textContent = "Доля «" + state.otpPhrase + "» от общих";
  $("statLeader").textContent = t.leader || "—";
  $("statLeaderOtp").textContent = t.leaderOtp || "—";
  $("exportBtn").disabled = false;

  renderKpi();
  renderRegionsChart();
  renderDynamicsChart();
  renderPenetrationChart();
  renderGrowthIndexChart();
  renderDistChart();
  renderSeasonalityChart();
  renderShareChart("shareOtp", "otp");
  renderShareChart("shareMarket", "market");
  renderRegionsTable();
}

function destroy(name) { if (charts[name]) { charts[name].destroy(); charts[name] = null; } }

// ------------------------------------------------- агрегация по периоду ----
function periodKey() { return $("period").value || "month"; }

function aggregate(hist, period) {
  if (period === "month") {
    return { labels: hist.labels.slice(), market: hist.market.slice(),
      otp: hist.otp.slice(), counts: hist.keys.map(() => 1) };
  }
  const order = [], map = {};
  hist.keys.forEach((k, i) => {
    const y = k.slice(0, 4), m = parseInt(k.slice(5, 7), 10);
    const id = period === "year" ? y : y + "Q" + Math.ceil(m / 3);
    const label = period === "year" ? y : Math.ceil(m / 3) + " кв. " + y;
    if (!(id in map)) { map[id] = { market: 0, otp: 0, count: 0, label }; order.push(id); }
    map[id].market += hist.market[i];
    map[id].otp += hist.otp[i];
    map[id].count += 1;
  });
  return {
    labels: order.map((id) => map[id].label),
    market: order.map((id) => map[id].market),
    otp: order.map((id) => map[id].otp),
    counts: order.map((id) => map[id].count),
  };
}

function periodUnit() {
  const p = periodKey();
  return p === "year" ? "год" : p === "quarter" ? "квартал" : "месяц";
}

// Все ключевые цифры зависят от выбранного периода: «за год» → за последний
// полный год, «за квартал/месяц» — за последний полный квартал/месяц.
function renderKpi() {
  const period = periodKey();
  const agg = aggregate(state.hist, period);
  const need = period === "year" ? 12 : period === "quarter" ? 3 : 1;
  const full = [];
  for (let i = 0; i < agg.counts.length; i++) if (agg.counts[i] >= need) full.push(i);
  const li = full.length ? full[full.length - 1] : agg.market.length - 1;

  const market = li >= 0 ? agg.market[li] : 0;
  const otp = li >= 0 ? agg.otp[li] : 0;
  const share = market ? otp / market * 100 : 0;
  const blabel = li >= 0 ? agg.labels[li] : "—";

  $("statMarket").textContent = fmt(market);
  $("statMarketFoot").textContent = "за " + blabel;
  $("statOtpShare").textContent = share.toFixed(3).replace(".", ",") + "%";
  $("statOtpFoot").textContent = "за " + blabel;

  // Изменение: последний полный период к предыдущему.
  [["Market", "market"], ["Otp", "otp"]].forEach(([suf, field]) => {
    const el = $("growth" + suf), foot = $("growth" + suf + "Foot");
    if (full.length < 2 || !agg[field][full[full.length - 2]]) {
      el.textContent = "—"; el.className = "stat-value"; foot.textContent = "недостаточно данных";
      return;
    }
    const i1 = full[full.length - 2], i2 = full[full.length - 1];
    const pct = (agg[field][i2] - agg[field][i1]) / agg[field][i1] * 100;
    const up = pct >= 0;
    el.textContent = (up ? "+" : "−") + Math.abs(pct).toFixed(1).replace(".", ",") + " %";
    el.className = "stat-value " + (up ? "growth-up" : "growth-down");
    foot.textContent = agg.labels[i2] + " к " + agg.labels[i1];
  });

  // Пик: рекордный период в выбранной гранулярности (только полные периоды).
  const peak = (field) => {
    let hi = -1, hidx = -1;
    full.forEach((i) => { if (agg[field][i] > hi) { hi = agg[field][i]; hidx = i; } });
    return { label: hidx >= 0 ? agg.labels[hidx] : "—", val: hi > 0 ? hi : 0 };
  };
  const unit = periodUnit();
  const pm = peak("market"), po = peak("otp");
  $("peakMarket").textContent = pm.label;
  $("peakMarketFoot").textContent = "рекордный " + unit + " · " + fmt(pm.val) + " показов";
  $("peakOtp").textContent = po.label;
  $("peakOtpFoot").textContent = "рекордный " + unit + " · " + fmt(po.val) + " показов";
}

// --------------------------------------------------- регионы: рынок + ОТП --
function renderRegionsChart() {
  const rows = state.regions.slice(0, topLimit);
  $("regionsChart").parentElement.style.height = Math.max(420, rows.length * 27) + "px";
  destroy("regions");
  charts.regions = new Chart($("regionsChart"), {
    type: "bar",
    data: {
      labels: rows.map((r) => r.name),
      datasets: [
        { key: "market", label: "Рынок", data: rows.map((r) => r.market),
          backgroundColor: C.market, borderRadius: 4, categoryPercentage: .76, barPercentage: .92 },
        { key: "otp", label: "ОТП", data: rows.map((r) => r.otp),
          backgroundColor: C.otp, borderRadius: 4, categoryPercentage: .76, barPercentage: .92 },
      ],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: { label: (ctx) => {
          const r = rows[ctx.dataIndex];
          return ctx.dataset.key === "market"
            ? "Рынок: " + fmt(r.market)
            : "ОТП: " + fmt(r.otp) + " · доля ОТП " + fmtPct(r.penetration);
        } } },
      },
      scales: { x: { ticks: { callback: shortNum } }, y: { ticks: { autoSkip: false, font: { size: 11 } } } },
    },
  });
}

// ------------------------------------------- динамика: 2 оси (ОТП + рынок) --
function renderDynamicsChart() {
  const agg = aggregate(state.dynHist, periodKey());
  destroy("dynamics");
  charts.dynamics = new Chart($("dynamicsChart"), {
    type: "line",
    data: {
      labels: agg.labels,
      datasets: [
        { label: "ОТП", data: agg.otp, yAxisID: "yOtp", borderColor: C.otp,
          backgroundColor: C.otpSoft, fill: true, tension: .35, pointRadius: 0, borderWidth: 2.5 },
        { label: "Рынок", data: agg.market, yAxisID: "yMarket", borderColor: C.market,
          backgroundColor: C.marketSoft, fill: false, tension: .35, pointRadius: 0, borderWidth: 2.5 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: {
          label: (c) => " " + c.dataset.label + ": " + fmt(c.parsed.y),
          afterBody: (items) => {
            if (!items.length) return "";
            const i = items[0].dataIndex;
            const m = agg.market[i], o = agg.otp[i];
            return m ? "доля ОТП: " + (o / m * 100).toFixed(2).replace(".", ",") + "%" : "";
          },
        } },
      },
      scales: {
        yOtp: { position: "left", title: { display: true, text: "ОТП", color: C.otp },
          ticks: { callback: shortNum, color: C.otp }, grid: { color: "#f1f1f8" } },
        yMarket: { position: "right", title: { display: true, text: "Рынок", color: C.market },
          ticks: { callback: shortNum, color: C.market }, grid: { drawOnChartArea: false } },
        x: { ticks: { maxRotation: 50, minRotation: 45, autoSkip: true, font: { size: 10 } } },
      },
    },
  });
}

// ------------------------------------------- доля ОТП во времени (тренд) ----
function renderPenetrationChart() {
  const h = state.hist;
  const share = h.market.map((m, i) => (m ? h.otp[i] / m * 100 : 0));
  destroy("penetration");
  charts.penetration = new Chart($("penetrationChart"), {
    type: "line",
    data: {
      labels: h.labels,
      datasets: [{ label: "Доля ОТП, %", data: share, borderColor: C.otp,
        backgroundColor: C.otpSoft, fill: true, tension: .35, pointRadius: 0, borderWidth: 2.5 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => " доля ОТП: " + c.parsed.y.toFixed(3).replace(".", ",") + "%" } } },
      scales: {
        x: { ticks: { maxRotation: 50, minRotation: 45, autoSkip: true, font: { size: 10 } } },
        y: { ticks: { callback: (v) => v.toFixed(1).replace(".", ",") + "%" } },
      },
    },
  });
}

// --------------------------------------- индекс роста: рынок vs ОТП (=100) --
function renderGrowthIndexChart() {
  const h = state.hist;
  const i0m = h.market.findIndex((v) => v > 0);
  const i0o = h.otp.findIndex((v) => v > 0);
  const baseM = i0m >= 0 ? h.market[i0m] : 0;
  const baseO = i0o >= 0 ? h.otp[i0o] : 0;
  const idxM = h.market.map((v) => (baseM ? v / baseM * 100 : null));
  const idxO = h.otp.map((v) => (baseO ? v / baseO * 100 : null));
  destroy("growthIndex");
  charts.growthIndex = new Chart($("growthIndexChart"), {
    type: "line",
    data: {
      labels: h.labels,
      datasets: [
        { label: "Рынок", data: idxM, borderColor: C.market, backgroundColor: "transparent",
          tension: .35, pointRadius: 0, borderWidth: 2.5, spanGaps: true },
        { label: "ОТП", data: idxO, borderColor: C.otp, backgroundColor: "transparent",
          tension: .35, pointRadius: 0, borderWidth: 2.5, spanGaps: true },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: true, position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: { label: (c) => " " + c.dataset.label + ": " + Math.round(c.parsed.y) } } },
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true, font: { size: 10 } } },
        y: { ticks: { callback: (v) => Math.round(v) } },
      },
    },
  });
}

// ----------------------------------- гистограмма распределения по диапазонам --
function renderDistChart() {
  const { labels, data } = buildHistogram(state.regions.map((r) => r.market));
  destroy("dist");
  charts.dist = new Chart($("distChart"), {
    type: "bar",
    data: { labels, datasets: [{ label: "Регионов в диапазоне", data, backgroundColor: C.orange, borderRadius: 5 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.parsed.y + " регион(ов)" } } },
      scales: {
        x: { ticks: { font: { size: 10 } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: "число регионов" } },
      },
    },
  });
}

// ------------------------------------------------ сезонность рынка по годам --
function renderSeasonalityChart() {
  const h = state.hist;
  const years = {};
  h.keys.forEach((k, i) => {
    const y = k.slice(0, 4), m = parseInt(k.slice(5, 7), 10) - 1;
    (years[y] = years[y] || new Array(12).fill(null))[m] = h.market[i];
  });
  const ys = Object.keys(years).sort();
  const recent = ys.slice(-5);
  const datasets = recent.map((y, idx) => ({
    label: y, data: years[y],
    borderColor: SEASON_COLORS[idx % SEASON_COLORS.length],
    backgroundColor: "transparent", tension: .35, pointRadius: 0, spanGaps: true,
    borderWidth: idx === recent.length - 1 ? 3 : 1.8,
  }));
  destroy("seasonality");
  charts.seasonality = new Chart($("seasonalityChart"), {
    type: "line",
    data: { labels: MONTH_ABBR, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: true, position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: { label: (c) => " " + c.dataset.label + ": " + fmt(c.parsed.y) } } },
      scales: { y: { ticks: { callback: shortNum } } },
    },
  });
}

// ----------------------------------- пай-чарты: ОТП и рынок + «остальные» --
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
  const origData = data.slice();   // исходные значения для пересчёта «Остальных»

  destroy(name);
  charts[name] = new Chart($(canvas), {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: bg, borderWidth: 2, borderColor: "#fff" }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "58%",
      plugins: {
        legend: {
          position: "right",
          labels: { font: { size: 11 }, boxWidth: 12, padding: 7 },
          // Скрытый регион переносится в «Остальные регионы» (сумма сохраняется).
          onClick: (e, item, legend) => {
            const ci = legend.chart;
            const idx = item.index;
            ci.toggleDataVisibility(idx);
            if (othersIdx >= 0 && idx !== othersIdx) {
              let extra = 0;
              for (let i = 0; i < origData.length; i++) {
                if (i !== othersIdx && ci.getDataVisibility(i) === false) extra += origData[i];
              }
              ci.data.datasets[0].data[othersIdx] = origData[othersIdx] + extra;
            }
            ci.update();
          },
        },
        tooltip: { callbacks: { label: (c) => {
          const total = c.dataset.data.reduce((s, v) => s + v, 0) || 1;
          return " " + c.label + ": " + fmt(c.parsed) + " (" + (c.parsed / total * 100).toFixed(1) + "%)";
        } } },
      },
    },
  });
}

// --------------------------------------------------------------- таблица --
function renderRegionsTable() {
  const q = $("tableFilter").value.trim().toLowerCase();
  const tbody = $("regionsTable").querySelector("tbody");
  tbody.innerHTML = "";
  state.regions
    .filter((r) => !q || r.name.toLowerCase().includes(q))
    .forEach((r, i) => {
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
  optAll.value = "ALL";
  optAll.textContent = "Все регионы РФ";
  sel.appendChild(optAll);
  state.regions.forEach((r) => {
    const o = document.createElement("option");
    o.value = r.id;
    o.textContent = r.name;
    sel.appendChild(o);
  });
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : "ALL";
}

async function refreshDynamics() {
  if (!state.marketPhrase) return;
  try {
    const resp = await fetch("/api/dynamics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phrase: state.marketPhrase,
        region: $("dynRegion").value || "ALL",
        devices: [$("device").value],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Ошибка запроса динамики");
    state.dynHist = data.dynamics || state.dynHist;
    renderDynamicsChart();
  } catch (err) {
    showError(err.message);
  }
}

async function onExport() {
  const btn = $("exportBtn");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Формирование…";
  try {
    const resp = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phrase: state.marketPhrase,
        otpPhrase: state.otpPhrase,
        regions: state.regions,
        dynamics: state.hist,
      }),
    });
    if (!resp.ok) throw new Error("Не удалось сформировать файл");
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "wordstat_" + (state.marketPhrase || "export").replace(/\s+/g, "_") + ".xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// --------------------------------------------------------------- helpers --
function shortNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".0", "") + " млн";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(".0", "") + " тыс";
  return String(Math.round(n));
}

function niceStep(raw) {
  if (raw <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * p;
}

function buildHistogram(counts) {
  if (!counts.length) return { labels: [], data: [] };
  const max = Math.max(...counts);
  const step = niceStep(max / 8) || 1;
  const bins = Math.max(1, Math.ceil((max + 1) / step));
  const data = new Array(bins).fill(0);
  counts.forEach((c) => {
    let i = Math.floor(c / step);
    if (i >= bins) i = bins - 1;
    data[i]++;
  });
  const labels = data.map((_, i) => shortNum(i * step) + "–" + shortNum((i + 1) * step));
  return { labels, data };
}

function showError(msg) {
  const el = $("error");
  if (!msg) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.textContent = msg;
  el.classList.remove("hidden");
}
