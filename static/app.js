"use strict";

// Состояние последнего ответа — используется для выгрузки и перерисовки графиков.
let state = { phrase: "", regions: [], dynamics: [], top: { results: [] }, windowLabels: [] };
let charts = { regions: null, dynamics: null, share: null, dist: null };
let topLimit = 15;

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n || 0).toLocaleString("ru-RU");

const BRAND = "#52AE30";
// Зелёная палитра в фирменном стиле ОТП Банка.
const PALETTE = ["#52AE30", "#0a7d3c", "#8DCB6B", "#2f7d4f", "#b6e0a0",
  "#1f9d55", "#3fae6a", "#6fae3a", "#0f7a4a", "#9ccf7a"];

document.addEventListener("DOMContentLoaded", () => {
  checkStatus();
  $("searchForm").addEventListener("submit", onSearch);
  $("exportBtn").addEventListener("click", onExport);
  $("tableFilter").addEventListener("input", renderRegionsTable);
  $("dynRegion").addEventListener("change", refreshDynamics);
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
    const r = await fetch("/api/status");
    const s = await r.json();
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

  const body = {
    phrase,
    devices: [$("device").value],
    period: $("period").value,
  };

  try {
    const resp = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Ошибка запроса");

    state = {
      phrase: data.phrase,
      regions: data.regions || [],
      dynamics: data.dynamics || [],
      top: null,
      windowLabels: (data.window && data.window.labels) || [],
    };
    populateRegionSelect();
    renderAll(data);
    $("results").classList.remove("hidden");
  } catch (err) {
    showError(err.message);
  } finally {
    $("loader").classList.add("hidden");
    $("searchBtn").disabled = false;
  }
}

function renderAll(data) {
  $("statTotal").textContent = fmt(data.totalCount);
  $("statRegions").textContent = fmt(data.regionsCount);
  $("statLeader").textContent = data.regions && data.regions.length
    ? data.regions[0].name : "—";
  renderRegionsChart();
  renderDistChart();
  renderDynamicsChart();
  renderShareChart();
  renderRegionsTable();
}

function destroy(name) { if (charts[name]) { charts[name].destroy(); charts[name] = null; } }

function renderRegionsChart() {
  const rows = topLimit > 0 ? state.regions.slice(0, topLimit) : state.regions;
  destroy("regions");
  charts.regions = new Chart($("regionsChart"), {
    type: "bar",
    data: {
      labels: rows.map((r) => r.name),
      datasets: [{
        label: "Показов за месяц",
        data: rows.map((r) => r.count),
        backgroundColor: BRAND,
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => fmt(c.parsed.x) + " показов" } } },
      scales: { x: { ticks: { callback: (v) => fmt(v) } },
        y: { ticks: { autoSkip: false, font: { size: 11 } } } },
    },
  });
}

// Компактная подпись числа: 12 500 -> «12,5 тыс», 1 200 000 -> «1,2 млн».
function shortNum(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " млн";
  if (n >= 1e3) return (n / 1e3).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " тыс";
  return fmt(n);
}

// «Красивый» шаг гистограммы (1/2/2.5/5 × 10^k), чтобы границы диапазонов были round.
function niceStep(rawStep) {
  if (rawStep <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const frac = rawStep / pow;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return nice * pow;
}

// Гистограмма распределения: число регионов по диапазонам числа показов.
function buildHistogram(counts) {
  const max = counts.length ? Math.max(...counts) : 0;
  if (max <= 0) return { labels: ["0"], values: [counts.length] };
  const step = niceStep(max / 8);
  const binCount = Math.max(1, Math.floor(max / step) + 1);
  const values = new Array(binCount).fill(0);
  counts.forEach((c) => {
    const idx = Math.min(binCount - 1, Math.floor(c / step));
    values[idx] += 1;
  });
  const labels = values.map((_, i) =>
    shortNum(i * step) + "–" + shortNum((i + 1) * step));
  return { labels, values };
}

function renderDistChart() {
  const counts = state.regions.map((r) => r.count || 0);
  const hist = buildHistogram(counts);
  destroy("dist");
  charts.dist = new Chart($("distChart"), {
    type: "bar",
    data: {
      labels: hist.labels,
      datasets: [{
        label: "Регионов",
        data: hist.values,
        backgroundColor: BRAND,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => "Показов за месяц: " + items[0].label,
            label: (c) => fmt(c.parsed.y) + " регион(ов)",
          },
        },
      },
      scales: {
        x: { title: { display: true, text: "Диапазон числа показов" },
          ticks: { font: { size: 11 } } },
        y: { title: { display: true, text: "Число регионов" },
          beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
}

function dynamicsLabels() {
  if (state.windowLabels && state.windowLabels.length === state.dynamics.length) {
    return state.windowLabels;
  }
  return state.dynamics.map((d) => (d.date || "").slice(0, 7));
}

function renderDynamicsChart() {
  destroy("dynamics");
  charts.dynamics = new Chart($("dynamicsChart"), {
    type: "line",
    data: {
      labels: dynamicsLabels(),
      datasets: [{
        label: "Показов",
        data: state.dynamics.map((d) => d.count),
        borderColor: BRAND,
        backgroundColor: "rgba(82,174,48,.14)",
        fill: true, tension: .3, pointRadius: 3,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { ticks: { callback: (v) => fmt(v) } } },
    },
  });
}

function renderShareChart() {
  const rows = state.regions.slice(0, 10);
  destroy("share");
  charts.share = new Chart($("shareChart"), {
    type: "doughnut",
    data: {
      labels: rows.map((r) => r.name),
      datasets: [{ data: rows.map((r) => r.count),
        backgroundColor: PALETTE, borderWidth: 1, borderColor: "#fff" }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "right", labels: { font: { size: 11 }, boxWidth: 12 } } },
    },
  });
}

function renderRegionsTable() {
  const q = $("tableFilter").value.trim().toLowerCase();
  const tbody = $("regionsTable").querySelector("tbody");
  tbody.innerHTML = "";
  state.regions
    .filter((r) => !q || r.name.toLowerCase().includes(q))
    .forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${i + 1}</td><td>${r.name}</td>` +
        `<td>${fmt(r.count)}</td><td>${(r.share || 0).toFixed(2)}</td>` +
        `<td>${Math.round(r.affinityIndex || 0)}</td>`;
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
  // Сохраняем выбор, если регион всё ещё присутствует.
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : "ALL";
}

async function refreshDynamics() {
  if (!state.phrase) return;
  const region = $("dynRegion").value || "ALL";
  try {
    const resp = await fetch("/api/dynamics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phrase: state.phrase,
        region,
        devices: [$("device").value],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Ошибка запроса динамики");
    state.dynamics = data.dynamics || [];
    state.windowLabels = (data.window && data.window.labels) || state.windowLabels;
    renderDynamicsChart();
  } catch (err) {
    showError(err.message);
  }
}

async function onExport() {
  const btn = $("exportBtn");
  btn.disabled = true;
  btn.textContent = "Формирование…";
  try {
    const resp = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    if (!resp.ok) throw new Error("Не удалось сформировать файл");
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "wordstat_" + (state.phrase || "export").replace(/\s+/g, "_") + ".xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "⬇ Выгрузить в Excel";
  }
}

function showError(msg) {
  const el = $("error");
  if (!msg) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.textContent = msg;
  el.classList.remove("hidden");
}
