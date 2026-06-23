"use strict";

// fullHist — полная месячная история; hist — срез по выбранному диапазону
// дат (rangeFrom..rangeTo). Все графики и KPI считаются от hist.
let state = {
  marketPhrase: "", otpPhrase: "", year: null,
  subjects: [], hist: { keys: [], labels: [], market: [], otp: [] },
  fullHist: { keys: [], labels: [], market: [], otp: [] },
  regions: [], dynRegion: "ALL", bucketLabel: "", competitors: [],
  source: "", queryPhrase: "", knownPhrases: [],
  brandOtp: [], brandOtpFull: [], mobile: null, mobileFull: null,
  // Брендовый спрос банков (реальные ряды из /api/brands). banks — текущий
  // список банков-конкурентов (без ОТП); bankSeriesFull — кэш по query за 48
  // мес.; bankSeries — срез под выбранный период.
  banks: [], bankSeriesFull: {}, bankSeries: {}, banksLoading: false,
};
let charts = {};
let topLimit = 15;
let excluded = new Set();   // id субъектов, исключённых из части графиков
let regionRank = "market";  // ранжирование распределения: market | penetration
let pieMetric = "market";   // пайчарт: market | otp (Рынок слева — по умолчанию)
let keyRateMap = null;      // помесячная ставка ЦБ РФ из /api/keyrate (или null)
let seasonMetric = "market";// сезонность: market | otp
let keyRateMetric = "market"; // запросы на графике ставки: market | otp
let growthStart = 0;        // индекс стартовой точки темпа роста (=100)

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n || 0).toLocaleString("ru-RU");
const esc = (s) => { const d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; };
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
// Фирменные цвета банков (для конкурентных графиков) — совпадают с реальными
// брендами (напр. Газпромбанк — тёмно-синий). Неизвестный банк получит цвет
// из категориальной палитры по хешу имени.
const BRAND_COLORS = {
  "ОТП": "#7AB829", "Сбер": "#21A038", "Т-Банк": "#F5C400", "Альфа": "#EF3124",
  "ВТБ": "#009FDF", "Газпромбанк": "#1C3F94", "Россельхозбанк": "#00573F",
  "Совкомбанк": "#B5121B", "Открытие": "#00B0CA", "Райффайзен": "#E8A200",
  "Почта Банк": "#2B57A7", "МКБ": "#7A1FA2", "Росбанк": "#E4002B",
  "Тинькофф": "#F5C400", "Уралсиб": "#00803B", "Дом.РФ": "#00A0A0",
};
const brandColor = (b) => BRAND_COLORS[b] || CAT_COLORS[(hashStr(b) % CAT_COLORS.length)];

// Пресеты банков: отображаемое имя -> брендовый запрос для API. Топ-банки по
// умолчанию + словарь для распознавания добавленного пользователем банка.
const BANK_PRESETS = [
  { name: "Сбер", query: "Сбербанк" },
  { name: "Т-Банк", query: "Т-Банк" },
  { name: "Альфа", query: "Альфа-Банк" },
  { name: "ВТБ", query: "ВТБ" },
  { name: "Газпромбанк", query: "Газпромбанк" },
  { name: "Россельхозбанк", query: "Россельхозбанк" },
  { name: "Совкомбанк", query: "Совкомбанк" },
  { name: "Открытие", query: "банк Открытие" },
  { name: "Райффайзен", query: "Райффайзенбанк" },
  { name: "Почта Банк", query: "Почта Банк" },
  { name: "МКБ", query: "МКБ банк" },
  { name: "Росбанк", query: "Росбанк" },
  { name: "Уралсиб", query: "Уралсиб" },
];
// Топ-5 банков по умолчанию (без ОТП — ОТП приходит из основного поиска).
const DEFAULT_BANKS = ["Сбер", "Т-Банк", "Альфа", "ВТБ"];
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
  $("rangeFrom").addEventListener("change", () => { if (state.fullHist.keys.length) applyRange(); });
  $("rangeTo").addEventListener("change", () => { if (state.fullHist.keys.length) applyRange(); });
  // Быстрый анализ всей истории: сбрасываем «с … по …» одним кликом.
  $("rangeAllBtn").addEventListener("click", () => {
    $("rangeFrom").value = "";
    $("rangeTo").value = "";
    if (state.fullHist.keys.length) applyRange();
  });
  $("growthStart").addEventListener("change", () => { growthStart = parseInt($("growthStart").value, 10) || 0; renderGrowthIndexChart(); });
  document.querySelectorAll(".toggle-btn[data-top]").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".toggle-btn[data-top]").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      topLimit = parseInt(b.dataset.top, 10);
      renderRegionsChart();
    });
  });
  // Общий обработчик тумблеров с data-metric/data-rank.
  const bindToggle = (boxId, fn) => {
    document.querySelectorAll("#" + boxId + " .toggle-btn").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll("#" + boxId + " .toggle-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        fn(b.dataset);
      });
    });
  };
  bindToggle("rankToggle", (d) => { regionRank = d.rank; renderRegionsChart(); });
  bindToggle("pieToggle", (d) => { pieMetric = d.metric; renderShareChart(); });
  bindToggle("seasonToggle", (d) => { seasonMetric = d.metric; renderSeasonalityChart(); });
  bindToggle("keyRateToggle", (d) => { keyRateMetric = d.metric; renderKeyRateChart(); });

  // Добавление банка в брендовый анализ + подсказки в datalist.
  const dl = $("bankPresets");
  if (dl) BANK_PRESETS.forEach((p) => { const o = document.createElement("option"); o.value = p.name; dl.appendChild(o); });
  const bankForm = $("bankAddForm");
  if (bankForm) bankForm.addEventListener("submit", (e) => { e.preventDefault(); addBankFromInput(); });

  // Актуальная ключевая ставка ЦБ РФ — подгружается автоматически (с кэшем на
  // сервере). Если уже есть результат поиска — перерисовываем график ставки.
  fetch("/api/keyrate").then((r) => r.json()).then((d) => {
    if (d && d.rates && Object.keys(d.rates).length) {
      keyRateMap = d.rates;
      if (state.marketPhrase) renderKeyRateChart();
    }
  }).catch(() => {});
});

// ------------------------------------------- диапазон дат (с .. по) -------
// Парсит дату ИЗ ЛЮБОГО формата ввода в ключ месяца "YYYY-MM". Safari на macOS
// не поддерживает <input type=month>, поэтому ввод — обычный текст: принимаем
// «дд.мм.гггг», «мм.гггг», «гггг-мм», «гггг». Пусто/мусор → null.
function parseMonthKey(str) {
  const s = (str || "").trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/)))       // 2023-12 / 2023-12-01
    return m[1] + "-" + String(+m[2]).padStart(2, "0");
  if ((m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/)))  // 01.12.2023 (дд.мм.гггг)
    return m[3] + "-" + String(+m[2]).padStart(2, "0");
  if ((m = s.match(/^(\d{1,2})[.\/](\d{4})$/)))                // 12.2023 (мм.гггг)
    return m[2] + "-" + String(+m[1]).padStart(2, "0");
  if ((m = s.match(/^(\d{4})$/)))                              // 2023 → январь
    return m[1] + "-01";
  return null;
}

function setupRangeInputs() {
  // Для текстовых полей ничего не клампим/не чистим — пользовательский ввод
  // парсится и ограничивается окном уже в applyRange.
}

function applyRange(render = true) {
  const keys = state.fullHist.keys;
  if (!keys.length) return;
  const lo = keys[0], hi = keys[keys.length - 1];
  // Пусто/непарсится → открытая граница: начало = самые ранние данные,
  // конец = последний доступный месяц (≈ сегодня).
  let from = parseMonthKey($("rangeFrom").value) || lo;
  let to = parseMonthKey($("rangeTo").value) || hi;
  // Ограничиваем доступным окном Wordstat.
  if (from < lo) from = lo; if (from > hi) from = hi;
  if (to < lo) to = lo; if (to > hi) to = hi;
  if (from > to) { const t = from; from = to; to = t; }
  const i0 = Math.max(0, keys.findIndex((k) => k >= from));
  let i1 = keys.length - 1;
  for (let i = keys.length - 1; i >= 0; i--) { if (keys[i] <= to) { i1 = i; break; } }
  const sl = (a) => (a || []).slice(i0, i1 + 1);
  state.hist = { keys: sl(keys), labels: sl(state.fullHist.labels),
                 market: sl(state.fullHist.market), otp: sl(state.fullHist.otp) };
  state.brandOtp = sl(state.brandOtpFull);
  state.mobile = state.mobileFull
    ? { market: sl(state.mobileFull.market), otp: sl(state.mobileFull.otp) } : null;
  sliceBankSeries();
  growthStart = 0;
  if (render) renderAll();
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
    state.fullHist = data.dynamics || { keys: [], labels: [], market: [], otp: [] };
    state.source = data.source || "";
    state.queryPhrase = data.queryPhrase || "";
    state.knownPhrases = data.knownPhrases || [];
    state.brandOtpFull = data.brandOtp || [];
    state.mobileFull = data.mobile || null;
    state.dynRegion = "ALL";
    if (!state.banks.length) state.banks = defaultBanks();
    excluded.clear();
    setupRangeInputs();
    // ВАЖНО: показываем результаты ДО отрисовки графиков — иначе Chart.js
    // создаёт canvas в скрытом контейнере с нулевым размером, и на части
    // машин (Windows/Chrome, широкоформатные/4K) координаты ховера потом
    // «съезжают». Видимый контейнер = корректный размер canvas сразу.
    $("results").classList.remove("hidden");
    applyRange(false);          // hist = срез fullHist по выбранным датам
    renderBanner();
    populateRegionSelect();
    renderExcludeChips();
    renderAll();
    fetchBanks();               // реальные ряды банков (кэшируются, фраза-независимы)
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
  renderPeriodViews();
}

function onPeriodChange() {
  recomputeRegions();
  renderKpi();
  renderPeriodViews();
}

// Всё, что зависит от гранулярности/диапазона — пересчитывается целиком,
// чтобы смена «месяц/квартал/год» меняла разметку во всех графиках.
function renderPeriodViews() {
  renderRegionsChart();
  renderDynamicsChart();
  renderGrowthIndexChart();
  renderForecastChart();
  renderOpportunityChart();
  renderShareChart();
  renderBrandSection();
  renderSeasonalityChart();
  renderQualityKpis();
  renderIntentChart();
  renderMobileChart();
  renderKeyRateChart();
  renderRegionsTable();
  syncMap();
  // После того как раскладка устоялась (появился/исчез скроллбар, сменился DPR),
  // пере-синхронизируем размер canvas всех графиков — чтобы ховер/тултипы были
  // точны на любом мониторе и в любом браузере.
  requestAnimationFrame(() => {
    Object.values(charts).forEach((c) => { try { if (c) c.resize(); } catch (e) { /* noop */ } });
  });
}

// Передаёт текущее распределение по субъектам в модуль карты (map.js),
// если он подключён. Карта показывает все регионы (без учёта исключений).
function syncMap() {
  if (window.WordstatMap) window.WordstatMap.update(state.regions);
}

// ---------------------------------------------- агрегация и текущий бакет --
function periodKey() { return $("period").value || "year"; }

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

// Агрегирует один месячный ряд в бакеты выбранной гранулярности.
// mode "sum" — объёмы (запросы), "avg" — проценты/ставки. Пустые бакеты → null.
// keys по умолчанию — state.hist.keys (все графики строятся от него).
function aggByPeriod(values, period, mode = "sum", keys = state.hist.keys) {
  if (period === "month") {
    return { labels: state.hist.labels.slice(), keys: keys.slice(), values: values.slice() };
  }
  const order = [], map = {};
  keys.forEach((k, i) => {
    const y = k.slice(0, 4), m = parseInt(k.slice(5, 7), 10);
    const id = period === "year" ? y : y + "Q" + Math.ceil(m / 3);
    const label = period === "year" ? y : Math.ceil(m / 3) + " кв. " + y;
    const bk = period === "year" ? y + "-12"
      : y + "-" + String(Math.ceil(m / 3) * 3).padStart(2, "0");
    if (!(id in map)) { map[id] = { sum: 0, cnt: 0, label, key: bk }; order.push(id); }
    if (values[i] != null) { map[id].sum += values[i]; map[id].cnt += 1; }
  });
  return {
    labels: order.map((id) => map[id].label),
    keys: order.map((id) => map[id].key),
    values: order.map((id) => (map[id].cnt === 0 ? null : (mode === "avg" ? map[id].sum / map[id].cnt : map[id].sum))),
  };
}

// Все KPI-плитки и распределение по регионам считаются ЗА ВЕСЬ анализируемый
// период (срез state.hist), а гранулярность влияет только на разметку осей
// графиков — поэтому здесь суммируем по всему периоду, без бакетов.
function periodTotals() {
  const h = state.hist;
  const M = h.market.reduce((a, b) => a + (b || 0), 0);
  const O = h.otp.reduce((a, b) => a + (b || 0), 0);
  // «Динамика за период» = изменение от первого к последнему месяцу периода
  // (не зависит от выбранной гранулярности).
  const growth = (arr) => {
    const f = arr.find((v) => v > 0);
    const l = arr.length ? arr[arr.length - 1] : null;
    return (f && l != null) ? (l - f) / f * 100 : null;
  };
  const fi = h.market.findIndex((v) => v > 0);
  return {
    M, O, share: M ? O / M * 100 : 0,
    growthM: growth(h.market), growthO: growth(h.otp),
    firstLabel: h.labels[fi >= 0 ? fi : 0] || "", lastLabel: h.labels[h.labels.length - 1] || "",
  };
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

// Распределение по регионам берётся напрямую из API (срез по устройству уже
// учтён сервером), а гранулярность на него не влияет — поэтому без gamma-
// искажений: веса субъектов используются как есть.
function concentrationGamma() { return 1; }
function visibleRegions() { return state.regions.filter((r) => !excluded.has(r.id)); }

// Распределение тотала РФ по субъектам по РЕАЛЬНЫМ весам из API (запрос):
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
  const t = periodTotals();
  state.bucketLabel = "период";
  state.regions = computeRegions(state.subjects, t.M, t.O);
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
function renderKpi() {
  const t = periodTotals();
  // Подпись периода: если выбран не весь диапазон — показываем фактические
  // границы (подтверждение, что фильтр применился).
  const h = state.hist, lbl = h.labels;
  const isFull = h.keys.length === state.fullHist.keys.length;
  const periodLabel = (isFull || !lbl.length) ? "весь период"
    : (lbl[0] + " — " + lbl[lbl.length - 1]);
  $("statMarket").textContent = fmt(t.M);
  $("statMarketFoot").textContent = "за " + periodLabel;
  $("statOtpShare").textContent = t.share.toFixed(3).replace(".", ",") + "%";
  $("statOtpFoot").textContent = "за " + periodLabel;
  $("regionsPeriodNote").textContent = "за " + periodLabel;

  [["Market", "growthM"], ["Otp", "growthO"]].forEach(([suf, field]) => {
    const el = $("growth" + suf), foot = $("growth" + suf + "Foot");
    const g = t[field];
    if (g == null) {
      el.textContent = "—"; el.className = "stat-value"; foot.textContent = "недостаточно данных"; return;
    }
    el.textContent = signPct(g); el.className = "stat-value " + (g >= 0 ? "growth-up" : "growth-down");
    foot.textContent = t.firstLabel + " → " + t.lastLabel;
  });
}

// ----------------------------------------------------- регионы: рынок+ОТП --
function destroy(name) { if (charts[name]) { charts[name].destroy(); charts[name] = null; } }

function renderRegionsChart() {
  // Ранжирование: по числу запросов (рынок) или по доле ОТП (проникновению).
  const sorted = [...visibleRegions()].sort((a, b) =>
    regionRank === "penetration" ? b.penetration - a.penetration : b.market - a.market);
  const rows = sorted.slice(0, topLimit);
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
        // Легенда не нужна — её роль играет подпись с цветными ключами под H2.
        legend: { display: false },
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

function renderGrowthIndexChart() {
  const agg = aggregate(state.hist, periodKey());

  // Селект стартовой точки (=100): заполняем подписями текущей агрегации.
  const sel = $("growthStart");
  if (sel.options.length !== agg.labels.length ||
      (sel.options[0] && sel.options[0].textContent !== "Старт: " + agg.labels[0])) {
    sel.innerHTML = "";
    agg.labels.forEach((lab, i) => {
      const o = document.createElement("option");
      o.value = i; o.textContent = "Старт: " + lab;
      sel.appendChild(o);
    });
  }
  if (growthStart >= agg.labels.length) growthStart = 0;
  sel.value = String(growthStart);

  const s = growthStart;
  const labels = agg.labels.slice(s);
  const mSeries = agg.market.slice(s), oSeries = agg.otp.slice(s);
  const bM = mSeries.find((v) => v > 0) || 0, bO = oSeries.find((v) => v > 0) || 0;
  const idxM = mSeries.map((v) => (bM ? v / bM * 100 : null));
  const idxO = oSeries.map((v) => (bO ? v / bO * 100 : null));
  destroy("growthIndex");
  charts.growthIndex = new Chart($("growthIndexChart"), {
    type: "line",
    data: {
      labels,
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

// Динамика доли запросов ОТП за период (otp ÷ рынок, %), бакетируется по
// выбранной гранулярности (только разметка оси X).
function renderForecastChart() {
  const per = periodKey();
  const aggM = aggByPeriod(state.hist.market, per), aggO = aggByPeriod(state.hist.otp, per);
  const share = aggM.values.map((m, i) => (m ? aggO.values[i] / m * 100 : null));
  destroy("forecast");
  charts.forecast = new Chart($("forecastChart"), {
    type: "line",
    data: {
      labels: aggM.labels,
      datasets: [
        { label: "Доля ОТП", data: share, borderColor: C.otp, backgroundColor: C.otpSoft,
          fill: true, tension: .3, pointRadius: 0, borderWidth: 2.5, spanGaps: true },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => c.parsed.y == null ? "" : " Доля ОТП: " + c.parsed.y.toFixed(3).replace(".", ",") + "%" } },
      },
      scales: {
        x: { ticks: { maxRotation: 50, minRotation: 45, autoSkip: true, font: { size: 10 } } },
        y: { grace: "8%", ticks: { callback: (v) => v.toFixed(2).replace(".", ",") + "%" } },
      },
    },
  });
}

// Сезонность: разметка ВСЕГДА по месяцам (12 по оси X), независимо от
// выбранной гранулярности. Каждая линия — отдельный календарный год.
function renderSeasonalityChart() {
  const metric = seasonMetric, canvasId = "seasonalityChart", chartKey = "seasonality";
  const h = state.hist;
  destroy(chartKey);

  const xLabels = MONTH_ABBR;
  const years = {};
  h.keys.forEach((k, i) => {
    const y = k.slice(0, 4), m = parseInt(k.slice(5, 7), 10) - 1;
    const row = years[y] = years[y] || new Array(12).fill(null);
    if (h[metric][i] != null) row[m] = (row[m] || 0) + h[metric][i];
  });
  const recent = Object.keys(years).sort().slice(-6);
  const datasets = recent.map((y, idx) => ({
    label: y, data: years[y], borderColor: YEAR_COLORS[idx % YEAR_COLORS.length], backgroundColor: "transparent",
    tension: .35, pointRadius: 0, spanGaps: true, borderWidth: idx === recent.length - 1 ? 3.2 : 1.8,
  }));
  charts[chartKey] = new Chart($(canvasId), {
    type: "line", data: { labels: xLabels, datasets },
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
  // Три кластера: «приоритет роста» (большой рынок, низкая доля), «сильные
  // позиции» (доля выше медианы — бывшие зелёный и фиолетовый объединены)
  // и «фоновые» (малый рынок, низкая доля).
  const pts = regs.map((r) => {
    const growth = r.market >= medX && r.penetration < medY;
    const strong = r.penetration >= medY;
    const color = growth ? C.orange : strong ? "#21A36B" : "#AEB6C4";
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
        x: { title: { display: true, text: "Количество запросов оверолл" }, ticks: { callback: shortNum } },
        y: { title: { display: true, text: "Доля ОТП, %" }, ticks: { callback: (v) => v.toFixed(1).replace(".", ",") + "%" } },
      },
    },
    plugins: [quadrantPlugin],
  });
}

function renderShareChart() {
  const name = "share", key = pieMetric, canvas = "shareChart";
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
      responsive: true, maintainAspectRatio: false, cutout: "62%",
      layout: { padding: 4 },
      plugins: {
        legend: {
          position: "bottom", align: "center",
          labels: { font: { size: 11.5 }, usePointStyle: true, pointStyle: "circle", boxWidth: 8, boxHeight: 8, padding: 9 },
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
  const rows = [...state.regions].sort((a, b) => b.market - a.market);
  const tbody = $("regionsTable").querySelector("tbody");
  tbody.innerHTML = "";
  rows.filter((r) => !q || r.name.toLowerCase().includes(q)).forEach((r, i) => {
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
// возможностей и агрегатную динамику частоты.
function renderExclusionViews() {
  renderRegionsChart();
  renderOpportunityChart();
  renderDynamicsChart();
}

// Чипы исключённых регионов показываются в двух местах: под распределением
// по регионам и под матрицей возможностей.
function renderExcludeChips() {
  const byId = Object.fromEntries(state.subjects.map((s) => [s.id, s.name]));
  ["excludeChips", "excludeChipsMatrix"].forEach((boxId) => {
    const box = $(boxId);
    if (!box) return;
    box.innerHTML = "";
    [...excluded].forEach((id) => {
      const chip = document.createElement("button");
      chip.type = "button"; chip.className = "chip";
      chip.innerHTML = byId[id] + ' <span aria-hidden="true">×</span>';
      chip.addEventListener("click", () => { excluded.delete(id); renderExcludeChips(); renderExclusionViews(); });
      box.appendChild(chip);
    });
    box.classList.toggle("hidden", excluded.size === 0);
  });
}

async function onExport() {
  const btn = $("exportBtn");
  btn.disabled = true; const label = btn.textContent; btn.textContent = "…";
  // Снимок дашборда в текущем состоянии (за анализируемый период): KPI,
  // динамика, регионы с Value Pool, бренды банков, сезонность и интенты.
  const t = periodTotals();
  const txt = (id) => $(id).textContent.trim();
  const kpi = {
    periodLabel: "за период", market: t.M, otp: t.O, share: t.share,
    range: (state.hist.labels[0] || "") + " — " + (state.hist.labels[state.hist.labels.length - 1] || ""),
    granularity: $("period").selectedOptions[0].textContent,
    growthMarket: txt("growthMarket") + " (" + txt("growthMarketFoot") + ")",
    growthOtp: txt("growthOtp") + " (" + txt("growthOtpFoot") + ")",
    sos: txt("sosValue") + " (" + txt("sosValueFoot") + ")",
    sosWinner: txt("sosLeader") + " (" + txt("sosLeaderFoot") + ")",
    bankTotal: txt("brandTotalVal") + " (" + txt("brandTotalFoot") + ")",
    bankGrowth: txt("brandGrowthVal") + " (" + txt("brandGrowthFoot") + ")",
    intentLeads: txt("kpiIntent"), intentService: txt("kpiService"),
    intentToxic: txt("kpiChurn"), seasonIdx: txt("kpiSeason"),
  };
  const sm = seasonalityMatrix("market"), so = seasonalityMatrix("otp");
  const spAbs = intentSplit().slice(-12);
  const intents = {
    labels: state.hist.labels.slice(-12),
    rows: spAbs.map((t) => [t.commercial, t.service, t.toxic, t.other]),
  };
  try {
    const resp = await fetch("/api/export", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phrase: state.marketPhrase, otpPhrase: state.otpPhrase,
        kpi,
        dynamics: state.hist,
        regions: valuePoolData().rows,
        // Брендовые запросы банков (как в SoS-блоке): ОТП — реальный ряд,
        // конкуренты — оценка; ряды выровнены по месяцам dynamics.
        competitors: (brandSeries() || []).map((r) => ({ brand: r.brand, series: r.series })),
        seasonality: { years: sm.years, months: MONTH_ABBR, market: sm.matrix, otp: so.matrix },
        intents,
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
// Все ряды банков — реальные из API (/api/brands). ОТП приходит из основного
// поиска (state.brandOtp). Пользователь может добавить любой банк — он так же
// анализируется, и весь блок (SoS, плитки, графики) пересчитывается.

// Имя банка -> {name, query, color}. Известный банк берёт пресет и брендовый
// цвет; произвольный ввод — сам себе query, цвет по хешу.
function resolveBank(input) {
  const s = (input || "").trim();
  if (!s) return null;
  const low = s.toLowerCase().replace(/банк/g, "").replace(/[^а-яёa-z0-9]/gi, "");
  for (const p of BANK_PRESETS) {
    const pl = p.name.toLowerCase().replace(/[^а-яёa-z0-9]/gi, "");
    const ql = p.query.toLowerCase().replace(/банк/g, "").replace(/[^а-яёa-z0-9]/gi, "");
    if (low && (low === pl || low === ql || pl.includes(low) || low.includes(ql))) {
      return { name: p.name, query: p.query, color: brandColor(p.name) };
    }
  }
  return { name: s, query: s, color: brandColor(s) };
}

function defaultBanks() {
  return DEFAULT_BANKS.map((n) => {
    const p = BANK_PRESETS.find((x) => x.name === n);
    return { name: n, query: p ? p.query : n, color: brandColor(n) };
  });
}

// Запрашивает реальные ряды банков и кэширует по query. Затем перерисовывает
// блок брендов. queries по умолчанию — текущий список банков.
function fetchBanks(queries) {
  const qs = (queries || state.banks.map((b) => b.query))
    .filter((q) => !(q in state.bankSeriesFull));
  if (!qs.length) { sliceBankSeries(); renderBrandSection(); return Promise.resolve(); }
  state.banksLoading = true;
  renderBrandSection();
  return fetch("/api/brands", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries: qs }),
  }).then((r) => r.json()).then((d) => {
    (d.series || []).forEach((s) => { state.bankSeriesFull[s.query] = s.monthly; });
  }).catch(() => {}).finally(() => {
    state.banksLoading = false;
    sliceBankSeries();
    renderBrandSection();
  });
}

// Срез кэшированных рядов банков под текущий период (по тем же индексам, что и
// state.hist в рамках 48-месячного окна).
function sliceBankSeries() {
  const fk = state.fullHist.keys;
  if (!fk.length) { state.bankSeries = {}; return; }
  const from = state.hist.keys[0], to = state.hist.keys[state.hist.keys.length - 1];
  let i0 = fk.indexOf(from), i1 = fk.indexOf(to);
  if (i0 < 0) i0 = 0;
  if (i1 < 0) i1 = fk.length - 1;
  state.bankSeries = {};
  Object.keys(state.bankSeriesFull).forEach((q) => {
    state.bankSeries[q] = state.bankSeriesFull[q].slice(i0, i1 + 1);
  });
}

function brandSeries() {
  const otp = state.brandOtp || [];
  if (!otp.some((v) => v != null)) return null;
  const rows = state.banks.map((b) => ({
    brand: b.name, color: b.color, removable: true,
    series: state.bankSeries[b.query] || otp.map(() => null),
  }));
  rows.push({ brand: "ОТП", color: C.otp, removable: false, series: otp.slice() });
  return rows;
}

function renderBrandSection() {
  const rows = brandSeries();
  const eyebrow = $("brandEyebrow"), sect = $("brandSection");
  if (!rows) { eyebrow.classList.add("hidden"); sect.classList.add("hidden"); return; }
  eyebrow.classList.remove("hidden"); sect.classList.remove("hidden");
  renderBankChips();

  // Пока реальные ряды банков не подгрузились — показываем заглушку вместо
  // вводящего в заблуждение «ОТП = 100% SoS».
  const haveBankData = state.banks.length === 0 ||
    state.banks.some((b) => (state.bankSeries[b.query] || []).some((v) => v != null));
  if (!haveBankData) {
    ["brandTotalVal", "brandGrowthVal", "sosValue", "sosLeader"].forEach((id) => { $(id).textContent = "…"; });
    return;
  }

  const nBanks = rows.length;
  const per = periodKey();
  // --- Графики: ряды банков по бакетам выбранной гранулярности (только ось X) ---
  const otpRow = rows.find((r) => r.brand === "ОТП");
  const otpAgg = aggByPeriod(otpRow.series, per);
  const valid = otpAgg.values.map((v, i) => (v != null && v > 0 ? i : -1)).filter((i) => i >= 0);
  const labels = valid.map((i) => otpAgg.labels[i]);
  const bankAgg = rows.map((r) => {
    const a = aggByPeriod(r.series, per);
    return { brand: r.brand, color: r.color, vals: valid.map((i) => a.values[i] || 0) };
  });
  const otpVals = bankAgg.find((r) => r.brand === "ОТП").vals;
  const total = labels.map((_, j) => bankAgg.reduce((a, r) => a + r.vals[j], 0));
  const sos = labels.map((_, j) => (total[j] ? otpVals[j] / total[j] * 100 : 0));

  // --- Плитки: считаются ЗА ВЕСЬ период по помесячным рядам (гранулярность
  // на них не влияет) ---
  const monthsN = otpRow.series.length;
  const totMonthly = [];
  for (let j = 0; j < monthsN; j++) totMonthly.push(rows.reduce((a, r) => a + (r.series[j] || 0), 0));
  const sumAll = totMonthly.reduce((a, b) => a + b, 0);
  const sumOtp = otpRow.series.reduce((a, b) => a + (b || 0), 0);
  const fi = totMonthly.findIndex((v) => v > 0), liM = monthsN - 1;

  // Плитка 1: суммарные запросы по всем выбранным банкам за период.
  $("brandTotalVal").textContent = fmt(sumAll);
  $("brandTotalFoot").textContent = "сумма " + nBanks + " банков за период";
  // Плитка 2: динамика запросов банков за период (первый → последний месяц).
  const gEl = $("brandGrowthVal");
  if (fi >= 0 && totMonthly[fi]) {
    const g = (totMonthly[liM] - totMonthly[fi]) / totMonthly[fi] * 100;
    gEl.textContent = signPct(g); gEl.className = "stat-value " + (g >= 0 ? "growth-up" : "growth-down");
  } else { gEl.textContent = "—"; gEl.className = "stat-value"; }
  $("brandGrowthFoot").textContent = "топ банков за период";

  // Плитка 3: SoS ОТП за период (сумма ОТП ÷ сумма всех банков).
  $("sosValue").textContent = (sumAll ? sumOtp / sumAll * 100 : 0).toFixed(2).replace(".", ",") + "%";
  $("sosValueFoot").textContent = "доля голоса за период";

  // Плитка 4: лидер роста SoS — макс. прирост доли голоса от начала к концу периода.
  const sosAt = (j) => rows.map((r) => (totMonthly[j] ? (r.series[j] || 0) / totMonthly[j] * 100 : 0));
  if (fi >= 0 && fi < liM) {
    const nowS = sosAt(liM), firstS = sosAt(fi);
    const deltas = nowS.map((v, k) => v - firstS[k]);
    let wi = 0; deltas.forEach((d, k) => { if (d > deltas[wi]) wi = k; });
    $("sosLeader").textContent = rows[wi].brand;
    $("sosLeaderFoot").textContent = (deltas[wi] >= 0 ? "+" : "−") + Math.abs(deltas[wi]).toFixed(2).replace(".", ",") + " п.п. SoS за период";
  } else {
    $("sosLeader").textContent = "—";
    $("sosLeaderFoot").textContent = "недостаточно данных";
  }

  // Границы и деления лог-оси — динамические по данным и по «красивым»
  // отметкам 1/2/5×10ⁿ (квартал/год дают суммы кратно больше помесячных,
  // фиксированный максимум их «срезал бы», а округление до 10ⁿ — пустит верх).
  const flatVals = bankAgg.flatMap((r) => r.vals).filter((v) => v > 0);
  const minV = flatVals.length ? Math.min(...flatVals) : 1e5;
  const maxV = flatVals.length ? Math.max(...flatVals) : 1e7;
  const logBound = (v, up) => {
    const e = Math.floor(Math.log10(v)), base = Math.pow(10, e), m = v / base, steps = [1, 2, 5, 10];
    if (up) { for (const s of steps) if (m <= s + 1e-9) return s * base; return 10 * base; }
    let r = base; for (const s of steps) if (s <= m + 1e-9) r = s * base; return r;
  };
  const yLo = logBound(minV, false), yHi = logBound(maxV, true);
  const LOG_TICKS = [];
  for (let e = Math.floor(Math.log10(yLo)); e <= Math.ceil(Math.log10(yHi)); e++) [1, 2, 5].forEach((m) => {
    const v = m * Math.pow(10, e); if (v >= yLo - 1 && v <= yHi + 1) LOG_TICKS.push(v);
  });
  destroy("brandDemand");
  charts.brandDemand = new Chart($("brandDemandChart"), {
    type: "line",
    data: { labels, datasets: bankAgg.map((r) => ({
      label: r.brand, data: r.vals,
      borderColor: r.color, backgroundColor: "transparent",
      borderWidth: r.brand === "ОТП" ? 3.6 : 2, tension: .35, pointRadius: 0,
    })) },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: { label: (c) => " " + c.dataset.label + ": " + fmt(c.parsed.y) } } },
      scales: {
        x: { ticks: { maxRotation: 50, minRotation: 45, autoSkip: true, font: { size: 10 } } },
        y: { type: "logarithmic", min: yLo, max: yHi,
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

// Чипы выбранных банков (ОТП — фиксированный, остальные удаляемые) + статус
// загрузки. Добавление/удаление банка пересчитывает весь блок.
function renderBankChips() {
  const box = $("bankChips");
  if (!box) return;
  box.innerHTML = "";
  const mk = (label, color, removable, onRemove) => {
    const chip = document.createElement("span");
    chip.className = "bank-chip";
    chip.innerHTML = '<span class="bank-dot" style="background:' + color + '"></span>' + esc(label);
    if (removable) {
      const x = document.createElement("button");
      x.type = "button"; x.className = "bank-chip-x"; x.setAttribute("aria-label", "Убрать " + label);
      x.textContent = "×";
      x.addEventListener("click", onRemove);
      chip.appendChild(x);
    }
    box.appendChild(chip);
  };
  mk("ОТП", C.otp, false, null);
  state.banks.forEach((b) => mk(b.name, b.color, true, () => removeBank(b.query)));
  if (state.banksLoading) {
    const s = document.createElement("span");
    s.className = "bank-loading"; s.textContent = "загрузка…";
    box.appendChild(s);
  }
}

function addBankFromInput() {
  const input = $("bankInput");
  const bank = resolveBank(input.value);
  if (!bank) return;
  input.value = "";
  if (state.banks.some((b) => b.query.toLowerCase() === bank.query.toLowerCase())) return;
  state.banks.push(bank);
  fetchBanks([bank.query]);   // дозапросим только новый банк; затем пересчёт
}

function removeBank(query) {
  state.banks = state.banks.filter((b) => b.query !== query);
  sliceBankSeries();
  renderBrandSection();       // пересчёт всего блока без новых запросов
}

// ------------------------------------- качество запросов: интенты, TQI, mobile --
// Демо-модель распределения брендовых запросов по интентам (в рабочем режиме
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

  // За период, а если данных мало (короткий диапазon) — по всей истории,
  // чтобы индекс считался всегда, а не показывал «—».
  const si = seasonalityIndex(state.hist.otp, state.hist.keys)
    || seasonalityIndex(state.fullHist.otp, state.fullHist.keys);
  $("kpiSeason").textContent = si ? si.index.toFixed(2).replace(".", ",") + "×" : "—";
  $("kpiSeasonFoot").textContent = si
    ? "Пиковый месяц («" + si.peak + "») выше среднемесячного объёма запросов ОТП в " + si.index.toFixed(2).replace(".", ",") + " раза - минимум «" + si.low + "»"
    : "пиковый месяц к среднемесячному объёму запросов ОТП";
}

// Подписи долей прямо на сегментах stacked-бара (без наведения).
const stackLabelsPlugin = {
  id: "stackLabels",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    ctx.save();
    ctx.font = "700 9px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      meta.data.forEach((bar, i) => {
        const v = ds.data[i];
        // Показываем подпись для любого ненулевого сегмента (включая узкий
        // «токсичный» в последнем месяце): порог по высоте — лишь 8px.
        if (v == null || v < 0.5 || !isFinite(bar.y) || Math.abs(bar.base - bar.y) < 8) return;
        ctx.fillStyle = ds.lightText ? "#fff" : "#2C3240";
        ctx.fillText(Math.round(v) + "%", bar.x, (bar.y + bar.base) / 2);
      });
    });
    ctx.restore();
  },
};

function renderIntentChart() {
  // Компоненты интентов агрегируются в бакеты выбранной гранулярности,
  // берём последние 12 бакетов.
  const per = periodKey();
  const split = intentSplit();
  const fields = ["commercial", "service", "toxic", "other"];
  const aggF = {};
  fields.forEach((f) => { aggF[f] = aggByPeriod(split.map((x) => x[f]), per).values; });
  const allLabels = aggByPeriod(split.map(() => 0), per).labels;
  const n = allLabels.length, from = Math.max(0, n - 12);
  const labels = allLabels.slice(from);
  const spAbs = [];
  for (let i = from; i < n; i++) {
    spAbs.push({ commercial: aggF.commercial[i] || 0, service: aggF.service[i] || 0,
                 toxic: aggF.toxic[i] || 0, other: aggF.other[i] || 0 });
  }
  // 100%-нормировка: каждый бакет = 100, сегменты — доли интентов.
  const sp = spAbs.map((t) => {
    const tot = t.commercial + t.service + t.toxic + t.other || 1;
    return { commercial: t.commercial / tot * 100, service: t.service / tot * 100,
             toxic: t.toxic / tot * 100, other: t.other / tot * 100, _abs: t, _tot: tot };
  });
  const mk = (label, f, color, lightText) => ({
    label, data: sp.map((x) => x[f]), backgroundColor: color, borderRadius: 3, stack: "s", lightText,
  });
  destroy("intent");
  charts.intent = new Chart($("intentChart"), {
    type: "bar",
    data: { labels, datasets: [
      mk("Продуктовый (лиды)", "commercial", "#52AE30", true),
      mk("Сервисный", "service", "#3D7BF0", true),
      mk("Токсичный", "toxic", "#e23b2e", true),
      mk("Прочее", "other", "#C7CCD8", false),
    ] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { weight: 700 } } },
        tooltip: { callbacks: { label: (c) => {
          const t = sp[c.dataIndex];
          const fld = ["commercial", "service", "toxic", "other"][c.datasetIndex];
          return " " + c.dataset.label + ": " + c.parsed.y.toFixed(1).replace(".", ",") + "% (" + fmt(t._abs[fld]) + ")";
        } } } },
      scales: { x: { stacked: true, ticks: { maxRotation: 50, minRotation: 45, font: { size: 10 } } },
        y: { stacked: true, max: 100, ticks: { callback: (v) => v + "%" } } },
    },
    plugins: [stackLabelsPlugin],
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
  // Проценты усредняются внутри бакета выбранной гранулярности.
  const per = periodKey();
  const aggMkt = aggByPeriod(mkt, per, "avg"), aggOtp = aggByPeriod(otp, per, "avg");
  const labels = aggMkt.labels;
  destroy("mobile");
  charts.mobile = new Chart($("mobileChart"), {
    type: "line",
    data: { labels, datasets: [
      { label: "ОТП", data: aggOtp.values, borderColor: C.otp, backgroundColor: C.otpSoft, fill: true, tension: .35, pointRadius: 0, borderWidth: 2.5 },
      { label: "Рынок", data: aggMkt.values, borderColor: C.market, backgroundColor: "transparent", tension: .35, pointRadius: 0, borderWidth: 2.5 },
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
  // Рабочий источник — актуальная ставка ЦБ (keyRateMap из /api/keyrate);
  // запасной — встроенная таблица, если CBR недоступен.
  if (keyRateMap) {
    return keys.map((k) => {
      const v = keyRateMap[k.slice(0, 7)];
      return v == null ? null : v;
    });
  }
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
  const per = periodKey();
  // Запросы (рынок/ОТП) суммируются по бакету, ставка усредняется.
  const reqMetric = keyRateMetric === "otp" ? "otp" : "market";
  const aggReq = aggByPeriod(state.hist[reqMetric], per, "sum");
  const aggRate = aggByPeriod(keyRateSeries(state.hist.keys), per, "avg");
  const isOtp = reqMetric === "otp";
  const reqColor = isOtp ? C.otp : C.market;
  const key = $("keyRateSeriesKey");
  if (key) { key.textContent = isOtp ? "запросы ОТП" : "запросы рынка"; key.className = "key " + (isOtp ? "key--otp" : "key--market"); }
  destroy("keyRate");
  charts.keyRate = new Chart($("keyRateChart"), {
    type: "line",
    data: { labels: aggReq.labels, datasets: [
      { label: isOtp ? "Запросы ОТП" : "Запросы рынка", data: aggReq.values, yAxisID: "y", borderColor: reqColor,
        backgroundColor: isOtp ? C.otpSoft : C.marketSoft, fill: true, tension: .35, pointRadius: 0, borderWidth: 2.5 },
      { label: "Ключевая ставка ЦБ, %", data: aggRate.values, yAxisID: "y2", borderColor: "#E8650A",
        borderDash: [6, 4], backgroundColor: "transparent", stepped: per === "month", pointRadius: 0, borderWidth: 2.2 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => c.dataset.yAxisID === "y2"
          ? " ставка: " + c.parsed.y.toFixed(2).replace(".", ",") + "%"
          : " запросы: " + fmt(c.parsed.y) } } },
      scales: {
        x: { ticks: { maxRotation: 50, minRotation: 45, autoSkip: true, font: { size: 10 } } },
        y: { position: "left", title: { display: true, text: "Запросы", color: reqColor }, ticks: { callback: shortNum } },
        y2: { position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "Ставка ЦБ, %", color: "#E8650A" },
          ticks: { callback: (v) => v + "%" } },
      },
    },
  });
}

// ------------------------------------------------- тепловая карта запросов --
function seasonalityMatrix(metric) {
  const h = state.hist, years = {};
  h.keys.forEach((k, i) => {
    const y = k.slice(0, 4), m = parseInt(k.slice(5, 7), 10) - 1;
    (years[y] = years[y] || new Array(12).fill(null))[m] = h[metric][i];
  });
  const ys = Object.keys(years).sort();
  return { years: ys, matrix: ys.map((y) => years[y]) };
}

// --------------------------------------------------------------- helpers --
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
}
function shortNum(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(".0", "") + " млрд";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".0", "") + " млн";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(".0", "") + " тыс";
  return String(Math.round(n));
}
function showError(msg) {
  const el = $("error");
  if (!msg) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.textContent = msg; el.classList.remove("hidden");
}
