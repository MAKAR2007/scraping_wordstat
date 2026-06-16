// Картограмма (choropleth) субъектов РФ — самодостаточный модуль.
// Рисует собственный SVG с проекцией Альберса (без сторонних библиотек и
// тайлов), раскрашивает регионы по объёму запросов текущей фразы.
// Данные приходят из app.js через window.WordstatMap.update(regions).
(function () {
  "use strict";
  const D2R = Math.PI / 180;
  const VBW = 1000, VBH = 560, PAD = 12;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("ru-RU");

  // Проекция Альберса (равновеликая коническая), настроена на РФ.
  const LAT0 = 56 * D2R, LON0 = 100 * D2R, P1 = 50 * D2R, P2 = 70 * D2R;
  const N = (Math.sin(P1) + Math.sin(P2)) / 2;
  const CC = Math.cos(P1) ** 2 + 2 * N * Math.sin(P1);
  const RHO0 = Math.sqrt(CC - 2 * N * Math.sin(LAT0)) / N;
  function albers(lon, lat) {
    const rho = Math.sqrt(CC - 2 * N * Math.sin(lat * D2R)) / N;
    const theta = N * (lon * D2R - LON0);
    return [rho * Math.sin(theta), RHO0 - rho * Math.cos(theta)];
  }

  let features = [];     // {id, name, d(pathString)}
  let paths = {};        // id -> <path>
  let svg = null, tip = null;
  let lastRegions = {};  // id -> {market, otp, name}
  let metric = "market";
  let built = false;

  document.addEventListener("DOMContentLoaded", () => {
    const host = $("regionMap");
    if (!host) return;
    document.querySelectorAll("#mapToggle .toggle-btn").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll("#mapToggle .toggle-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        metric = b.dataset.metric;
        recolor();
      });
    });
    loadGeo();
  });

  function loadGeo() {
    fetch("vendor/ru-subjects.geojson")
      .then((r) => r.json())
      .then((geo) => { buildPaths(geo.features); })
      .catch(() => { /* карта необязательна — молча пропускаем */ });
  }

  function buildPaths(feats) {
    // Спроецировать всё, найти границы, подогнать под viewBox.
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    const projected = feats.map((f) => {
      const rings = eachRing(f.geometry, (lon, lat) => {
        const [x, y] = albers(lon, lat);
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
        return [x, y];
      });
      return { id: f.properties.id, name: f.properties.name, rings };
    });
    const s = Math.min((VBW - 2 * PAD) / (maxx - minx), (VBH - 2 * PAD) / (maxy - miny));
    const ox = (VBW - s * (maxx - minx)) / 2, oy = (VBH - s * (maxy - miny)) / 2;
    const tx = (x) => ox + (x - minx) * s;
    const ty = (y) => oy + (y - miny) * s;   // y проекции растёт к северу -> экран вниз: инвертируем ниже
    features = projected.map((p) => ({
      id: p.id, name: p.name,
      d: p.rings.map((ring) =>
        "M" + ring.map(([x, y]) => tx(x).toFixed(1) + " " + (VBH - ty(y)).toFixed(1)).join("L") + "Z").join(" "),
    }));
    render();
    built = true;
    if (Object.keys(lastRegions).length) recolor();
  }

  // Обходит координаты Polygon/MultiPolygon, проецирует, возвращает массив колец.
  function eachRing(geom, proj) {
    const out = [];
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    polys.forEach((poly) => poly.forEach((ring) => {
      out.push(ring.map(([lon, lat]) => proj(lon, lat)));
    }));
    return out;
  }

  function render() {
    const host = $("regionMap");
    host.innerHTML = "";
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 " + VBW + " " + VBH);
    svg.setAttribute("class", "ru-map");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    paths = {};
    features.forEach((f) => {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", f.d);
      p.setAttribute("fill", "#eceef3");
      p.setAttribute("stroke", "#fff");
      p.setAttribute("stroke-width", "0.6");
      p.dataset.id = f.id == null ? "" : f.id;
      p.addEventListener("mousemove", (e) => showTip(e, f));
      p.addEventListener("mouseleave", hideTip);
      svg.appendChild(p);
      if (f.id != null) paths[f.id] = p;
    });
    host.appendChild(svg);
    tip = document.createElement("div");
    tip.className = "map-tip hidden";
    host.appendChild(tip);
  }

  // Палитра: светло-зелёный -> брендовый -> тёмный (последовательная).
  const STOPS = [[239, 246, 226], [122, 184, 41], [47, 82, 18]];
  function color(t) {
    t = Math.max(0, Math.min(1, t));
    const seg = t < 0.5 ? 0 : 1, lt = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
    const a = STOPS[seg], b = STOPS[seg + 1];
    const c = a.map((v, i) => Math.round(v + (b[i] - v) * lt));
    return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
  }

  function recolor() {
    if (!built) return;
    let max = 0;
    Object.values(lastRegions).forEach((r) => { const v = r[metric] || 0; if (v > max) max = v; });
    features.forEach((f) => {
      const p = paths[f.id];
      if (!p) return;
      const r = lastRegions[f.id];
      if (!r || !max) { p.setAttribute("fill", "#eceef3"); return; }
      // sqrt-нормировка — иначе Москва «съедает» всю шкалу.
      p.setAttribute("fill", color(Math.sqrt((r[metric] || 0) / max)));
    });
    const lbl = metric === "otp" ? "запросов ОТП" : "запросов рынка";
    if ($("mapLegendMax")) $("mapLegendMax").textContent = "макс. " + fmt(max) + " " + lbl;
  }

  function showTip(e, f) {
    if (!tip) return;
    const r = lastRegions[f.id];
    const host = $("regionMap"), rect = host.getBoundingClientRect();
    let html = "<b>" + esc(f.name) + "</b>";
    if (r) {
      const tot = sumMetric();
      const v = r[metric] || 0;
      html += "<br>" + (metric === "otp" ? "ОТП" : "Рынок") + ": " + fmt(v) +
        "<br>Доля РФ: " + (tot ? (v / tot * 100).toFixed(1).replace(".", ",") : "0") + "%";
    } else {
      html += "<br><span class=\"map-tip-muted\">нет данных</span>";
    }
    tip.innerHTML = html;
    tip.classList.remove("hidden");
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    tip.style.left = Math.min(x + 14, rect.width - 180) + "px";
    tip.style.top = Math.max(y - 10, 0) + "px";
  }

  function hideTip() { if (tip) tip.classList.add("hidden"); }
  function sumMetric() {
    let s = 0; Object.values(lastRegions).forEach((r) => s += (r[metric] || 0)); return s;
  }
  function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  // Публичный API для app.js.
  window.WordstatMap = {
    update(regions) {
      lastRegions = {};
      (regions || []).forEach((r) => { lastRegions[r.id] = { market: r.market, otp: r.otp, name: r.name }; });
      recolor();
    },
  };
})();
