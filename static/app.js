"use strict";

// Состояние последнего ответа — используется для выгрузки и перерисовки графиков.
let state = {
  marketPhrase: "",
  otpPhrase: "",
  regions: [],
  dyn: { labels: [], market: [], otp: [] },
  totals: {},
};
let charts = { regions: null, dynamics: null, dist: null, shareOtp: null, shareMarket: null };
let topLimit = 15;

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n || 0).toLocaleString("ru-RU");

// Семантика цветов: рынок = салатовый, ОТП = фиолетовый, акцент = оранжевый.
const C = {
  market: "#7AB829", marketSoft: "rgba(122,184,41,.16)",
  otp: "#6C4CF1", otpSoft: "rgba(108,76,241,.18)",
  orange: "#FF7A1A",
};
const MARKET_COLORS = ["#7AB829", "#8CC63F", "#69A220", "#A0D356", "#5F9A1E",
  "#4F851A", "#93CE4D", "#B4DD79", "#74B226", "#86C23A"];
const OTP_COLORS = ["#6C4CF1", "#7E5BF6", "#9277F8", "#5A3CD0", "#A78EF9",
  "#4B30B8", "#8466F4", "#B9A6FB", "#6E51E8", "#5544C9"];
const OTHERS_COLOR = "#C7CCD8";

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
  // Период влияет только на динамику → лёгкий перезапрос.
  $("period").addEventListener("change", () => {
    if (state.marketPhrase) refreshDynamics();
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
      body: JSON.stringify({
        phrase,
        devices: [$("device").value],
        period: $("period").value,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Ошибка запроса");

    state = {
      marketPhrase: data.marketPhrase,
      otpPhrase: data.otpPhrase,
      regions: data.regions || [],
      dyn: data.dynamics || { labels: [], market: [], otp: [] },
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
  $("statMarket").textContent = fmt(t.market);
  $("statOtpShare").textContent = (t.otpShare != null ? t.otpShare : 0) + "%";
  $("statOtpLabel").textContent = "Доля «" + state.otpPhrase + "» от общих";
  $("statLeader").textContent = t.leader || "—";
  renderRegionsChart();
  renderDynamicsChart();
  renderDistChart();
  renderShareChart("shareOtp", "otp", OTP_COLORS);
  renderShareChart("shareMarket", "market", MARKET_COLORS);
  renderRegionsTable();
}

function destroy(name) { if (charts[name]) { charts[name].destroy(); charts[name] = null; } }

// --------------------------------------------------- регионы: рынок + ОТП --
function renderRegionsChart() {
  const rows = state.regions.slice(0, topLimit);
  // Высота под количество строк, чтобы подписи не наезжали.
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
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const r = rows[ctx.dataIndex];
              return ctx.dataset.key === "market"
                ? "Рынок: " + fmt(r.market) + " показов"
                : "ОТП: " + fmt(r.otp) + " показов · доля ОТП " + r.penetration + "%";
            },
          },
        },
      },
      scales: {
        x: { ticks: { callback: shortNum } },
        y: { ticks: { autoSkip: false, font: { size: 11 } } },
      },
    },
  });
}

// ------------------------------------------- динамика: 2 оси (ОТП + рынок) --
function renderDynamicsChart() {
  destroy("dynamics");
  charts.dynamics = new Chart($("dynamicsChart"), {
    type: "line",
    data: {
      labels: state.dyn.labels,
      datasets: [
        { label: "ОТП", data: state.dyn.otp, yAxisID: "yOtp",
          borderColor: C.otp, backgroundColor: C.otpSoft, fill: true,
          tension: .35, pointRadius: 2, borderWidth: 2.5 },
        { label: "Рынок", data: state.dyn.market, yAxisID: "yMarket",
          borderColor: C.market, backgroundColor: C.marketSoft, fill: false,
          tension: .35, pointRadius: 2, borderWidth: 2.5 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: { label: (c) => " " + c.dataset.label + ": " + fmt(c.parsed.y) } },
      },
      scales: {
        yOtp: { position: "left", title: { display: true, text: "ОТП", color: C.otp },
          ticks: { callback: shortNum, color: C.otp }, grid: { color: "#f1f1f8" } },
        yMarket: { position: "right", title: { display: true, text: "Рынок", color: C.market },
          ticks: { callback: shortNum, color: C.market }, grid: { drawOnChartArea: false } },
        x: { ticks: { maxRotation: 0, autoSkip: true, font: { size: 11 } } },
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
    data: {
      labels,
      datasets: [{ label: "Регионов в диапазоне", data, backgroundColor: C.orange, borderRadius: 5 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => c.parsed.y + " регион(ов)" } },
      },
      scales: {
        x: { ticks: { font: { size: 10 } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: "число регионов" } },
      },
    },
  });
}

// ----------------------------------- пай-чарты: ОТП и рынок + «остальные» --
function renderShareChart(name, key, colors) {
  const canvas = name === "shareOtp" ? "shareOtpChart" : "shareMarketChart";
  const sorted = [...state.regions].sort((a, b) => b[key] - a[key]);
  const top = sorted.slice(0, 10);
  const restSum = sorted.slice(10).reduce((s, r) => s + (r[key] || 0), 0);
  const labels = top.map((r) => r.name);
  const data = top.map((r) => r[key]);
  const bg = colors.slice(0, top.length);
  if (restSum > 0) { labels.push("Остальные регионы"); data.push(restSum); bg.push(OTHERS_COLOR); }

  destroy(name);
  charts[name] = new Chart($(canvas), {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: bg, borderWidth: 2, borderColor: "#fff" }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "58%",
      plugins: {
        legend: { position: "right", labels: { font: { size: 11 }, boxWidth: 12, padding: 8 } },
        tooltip: {
          callbacks: {
            label: (c) => {
              const total = c.dataset.data.reduce((s, v) => s + v, 0) || 1;
              return " " + c.label + ": " + fmt(c.parsed) + " (" + (c.parsed / total * 100).toFixed(1) + "%)";
            },
          },
        },
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
        `<td class="num"><span class="tag-pen">${(r.penetration || 0).toFixed(1)}%</span></td>` +
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
        period: $("period").value,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Ошибка запроса динамики");
    state.dyn = data.dynamics || state.dyn;
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
        dynamics: state.dyn,
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
