// Картограмма (choropleth) субъектов РФ — самодостаточный модуль.
// Рисует собственный SVG с проекцией Альберса (без сторонних библиотек и
// тайлов), раскрашивает регионы по объёму запросов текущей фразы.
// Данные приходят из app.js через window.WordstatMap.update(regions).
// Каждый feature несёт список id субъектов Wordstat (properties.ids) — у
// «Москва и область» / «СПб и ЛО» он общий на два контура, у Крыма —
// суммируется по городам.
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

  let features = [];     // [{ids:[..], name, d}]
  let pathEls = [];      // <path>, индекс-в-индекс с features
  let svg = null, tip = null;
  let lastRegions = {};  // id -> {market, otp, name}
  let metric = "market";
  let built = false;

  document.addEventListener("DOMContentLoaded", () => {
    if (!$("regionMap")) return;
    document.querySelectorAll("#mapToggle .toggle-btn").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll("#mapToggle .toggle-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        metric = b.dataset.metric;
        recolor();
      });
    });
    loadGeo(0);
  });

  function loadGeo(attempt) {
    fetch("vendor/ru-subjects.geojson")
      .then((r) => { if (!r.ok) throw new Error("geojson " + r.status); return r.json(); })
      .then((geo) => buildPaths(geo.features))
      .catch(() => { if (attempt < 2) setTimeout(() => loadGeo(attempt + 1), 800); });
  }

  function buildPaths(feats) {
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    const projected = feats.map((f) => {
      const rings = eachRing(f.geometry, (lon, lat) => {
        const [x, y] = albers(lon, lat);
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
        return [x, y];
      });
      const ids = f.properties.ids || (f.properties.id != null ? [f.properties.id] : []);
      return { ids: ids.map(String), name: f.properties.name, rings };
    });
    const s = Math.min((VBW - 2 * PAD) / (maxx - minx), (VBH - 2 * PAD) / (maxy - miny));
    const ox = (VBW - s * (maxx - minx)) / 2, oy = (VBH - s * (maxy - miny)) / 2;
    const tx = (x) => ox + (x - minx) * s;
    const ty = (y) => oy + (y - miny) * s;
    features = projected.map((p) => ({
      ids: p.ids, name: p.name,
      d: p.rings.map((ring) =>
        "M" + ring.map(([x, y]) => tx(x).toFixed(1) + " " + (VBH - ty(y)).toFixed(1)).join("L") + "Z").join(" "),
    }));
    render();
    built = true;
    recolor();
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
    pathEls = features.map((f) => {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", f.d);
      p.setAttribute("fill", "#eceef3");
      p.setAttribute("stroke", "#fff");
      p.setAttribute("stroke-width", "0.6");
      p.addEventListener("mousemove", (e) => showTip(e, f));
      p.addEventListener("mouseleave", hideTip);
      svg.appendChild(p);
      return p;
    });
    host.appendChild(svg);
    tip = document.createElement("div");
    tip.className = "map-tip hidden";
    host.appendChild(tip);
  }

  // Сумма метрики по списку id субъектов (учёт «Москва и область» и Крыма).
  function valueOf(f) {
    let v = 0, has = false;
    f.ids.forEach((id) => { const r = lastRegions[id]; if (r) { v += r[metric] || 0; has = true; } });
    return has ? v : null;
  }
  function grandTotal() {
    let s = 0; Object.values(lastRegions).forEach((r) => s += (r[metric] || 0)); return s;
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
    features.forEach((f) => { const v = valueOf(f); if (v != null && v > max) max = v; });
    features.forEach((f, i) => {
      const v = valueOf(f);
      pathEls[i].setAttribute("fill", (v == null || !max) ? "#eceef3" : color(Math.sqrt(v / max)));
    });
    renderLegend(max);
  }

  // Легенда: горизонтальная цветовая шкала 0 → макс с подписями.
  function renderLegend(max) {
    const box = $("mapLegend");
    if (!box) return;
    if (!max) { box.innerHTML = ""; return; }
    const lbl = metric === "otp" ? "запросов ОТП" : "запросов рынка";
    box.innerHTML =
      '<span class="map-legend-cap">меньше</span>' +
      '<span class="map-legend-bar"></span>' +
      '<span class="map-legend-cap">больше · до ' + fmt(max) + " " + lbl + "</span>";
  }

  function showTip(e, f) {
    if (!tip) return;
    const host = $("regionMap"), rect = host.getBoundingClientRect();
    const v = valueOf(f);
    let html = "<b>" + esc(f.name) + "</b>";
    if (v != null) {
      const tot = grandTotal();
      html += "<br>" + (metric === "otp" ? "ОТП" : "Рынок") + ": " + fmt(v) +
        "<br>Доля РФ: " + (tot ? (v / tot * 100).toFixed(1).replace(".", ",") : "0") + "%";
    } else {
      html += "<br><span class=\"map-tip-muted\">нет данных</span>";
    }
    tip.innerHTML = html;
    tip.classList.remove("hidden");
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    tip.style.left = Math.min(Math.max(0, x + 14), Math.max(0, rect.width - 180)) + "px";
    tip.style.top = Math.max(y - 10, 0) + "px";
  }

  function hideTip() { if (tip) tip.classList.add("hidden"); }
  function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  // Публичный API для app.js.
  window.WordstatMap = {
    update(regions) {
      lastRegions = {};
      (regions || []).forEach((r) => { lastRegions[String(r.id)] = { market: r.market, otp: r.otp, name: r.name }; });
      recolor();
    },
  };
})();
