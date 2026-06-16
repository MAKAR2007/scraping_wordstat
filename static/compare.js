// Сравнение нескольких фраз — самодостаточный модуль (IIFE), не трогает
// основной дашборд (app.js). Чарт и данные держит локально.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("ru-RU");
  const COLORS = ["#6C4CF1", "#7AB829", "#FF7A1A", "#22B8CF", "#E8467C"];

  let chart = null;
  let lastData = null;

  document.addEventListener("DOMContentLoaded", () => {
    const toggle = $("compareToggle");
    if (!toggle) return;
    toggle.addEventListener("click", toggleBody);
    toggle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleBody(); }
    });
    $("compareBtn").addEventListener("click", runCompare);
    $("compareExportBtn").addEventListener("click", exportCompare);
  });

  function toggleBody() {
    const open = $("compareBody").classList.toggle("hidden") === false;
    $("compareCaret").classList.toggle("open", open);
    $("compareToggle").setAttribute("aria-expanded", String(open));
  }

  function parsePhrases() {
    const out = [], seen = new Set();
    for (let p of ($("comparePhrases").value || "").split("\n")) {
      p = p.trim();
      const key = p.toLowerCase();
      if (p && !seen.has(key)) { seen.add(key); out.push(p); }
    }
    return out.slice(0, 5);
  }

  async function runCompare() {
    const phrases = parsePhrases();
    showErr("");
    if (phrases.length < 2) {
      showErr("Введите минимум 2 разные фразы (по одной в строке).");
      return;
    }
    const dev = ($("device") && $("device").value) || "DEVICE_ALL";
    const months = parseInt($("compareMonths").value, 10) || 24;
    setLoading(true);
    try {
      const resp = await fetch("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrases, months, devices: [dev] }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Ошибка сравнения");
      lastData = data;
      render(data);
      $("compareResults").classList.remove("hidden");
    } catch (e) {
      showErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  function render(data) {
    const grand = data.series.reduce((s, x) => s + (x.total || 0), 0) || 1;

    if (chart) chart.destroy();
    chart = new Chart($("compareChart"), {
      type: "line",
      data: {
        labels: data.labels,
        datasets: data.series.map((s, i) => ({
          label: s.phrase,
          data: s.monthly,
          borderColor: COLORS[i % COLORS.length],
          backgroundColor: COLORS[i % COLORS.length],
          borderWidth: 2, tension: 0.3, pointRadius: 0, pointHoverRadius: 4,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } },
          tooltip: { callbacks: { label: (c) => c.dataset.label + ": " + fmt(c.parsed.y) } },
        },
        scales: { y: { beginAtZero: true, ticks: { callback: (v) => fmt(v) } } },
      },
    });

    const tbody = $("compareTable").querySelector("tbody");
    tbody.innerHTML = "";
    data.series.forEach((s, i) => {
      const m = s.monthly || [];
      const first = m.find((v) => v > 0) || 0;
      const last = m.length ? m[m.length - 1] : 0;
      const growth = first ? (last - first) / first * 100 : 0;
      const tr = document.createElement("tr");
      tr.innerHTML =
        '<td><span class="cmp-dot" style="background:' + COLORS[i % COLORS.length] + '"></span>' +
          esc(s.phrase) + '</td>' +
        '<td>' + fmt(s.total) + '</td>' +
        '<td>' + (s.total / grand * 100).toFixed(1).replace(".", ",") + '%</td>' +
        '<td class="' + (growth >= 0 ? "cmp-pos" : "cmp-neg") + '">' +
          (growth >= 0 ? "+" : "−") + Math.abs(growth).toFixed(1).replace(".", ",") + '%</td>';
      tbody.appendChild(tr);
    });

    $("compareNote").textContent = data.demo
      ? "Демо-данные (живой API недоступен). Известные продукты — реальные из выгрузки."
      : "Данные Yandex Wordstat (живой API).";
  }

  async function exportCompare() {
    if (!lastData) return;
    const btn = $("compareExportBtn"), label = btn.textContent;
    btn.disabled = true; btn.textContent = "…";
    try {
      const resp = await fetch("/api/compare/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels: lastData.labels, series: lastData.series }),
      });
      if (!resp.ok) throw new Error("Не удалось сформировать файл");
      const blob = await resp.blob(), url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "wordstat_сравнение.xlsx";
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      showErr(e.message);
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }

  function setLoading(on) {
    $("compareLoader").classList.toggle("hidden", !on);
    $("compareBtn").disabled = on;
  }

  function showErr(msg) {
    const el = $("compareError");
    if (!msg) { el.classList.add("hidden"); el.textContent = ""; return; }
    el.textContent = msg; el.classList.remove("hidden");
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }
})();
