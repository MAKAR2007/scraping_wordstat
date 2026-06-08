# -*- coding: utf-8 -*-
"""
Веб-дашборд статистики ключевых слов Yandex Wordstat.

Бэкенд проксирует запросы к Yandex Search API, строго разбивает данные по
субъектам РФ (федеральные округа исключаются) и формирует выгрузку в Excel.
"""

import io
import os
import sys

from flask import Flask, jsonify, request, send_file

from months import last_full_months, period_axis


def _load_dotenv():
    """Минимальная загрузка .env в окружение (без внешних зависимостей)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


_load_dotenv()

import dataset
from regions import all_subject_ids, build_subject_index, filter_to_subjects
from yandex_client import WordstatClient, YandexError

app = Flask(__name__, static_folder="static", static_url_path="")

# Индекс субъектов кэшируется на время жизни процесса.
_subject_index_cache = {"value": None}


def get_subject_index(client):
    if _subject_index_cache["value"] is None:
        try:
            tree = client.get_regions_tree()
        except YandexError:
            tree = None
        _subject_index_cache["value"] = build_subject_index(tree)
    return _subject_index_cache["value"]


@app.route("/")
def index():
    # send_static_file резолвит путь от root_path приложения (каталог app.py),
    # поэтому работает независимо от текущего рабочего каталога процесса.
    return app.send_static_file("index.html")


@app.route("/api/status")
def status():
    client = WordstatClient()
    return jsonify({"demo": client.demo_mode})


@app.route("/api/products")
def products():
    """Фразы с реальными данными по тоталу РФ (из ручной выгрузки CSV)."""
    return jsonify({"phrases": dataset.known_phrases()})


@app.route("/api/search", methods=["POST"])
def search():
    payload = request.get_json(force=True, silent=True) or {}
    phrase = (payload.get("phrase") or "").strip()
    if not phrase:
        return jsonify({"error": "Не задана ключевая фраза"}), 400

    devices = payload.get("devices") or None
    period = payload.get("period") or "PERIOD_MONTHLY"
    market_phrase = phrase
    otp_phrase = phrase + " ОТП"
    axis = period_axis(period)

    client = WordstatClient()
    index = get_subject_index(client)
    all_ids = all_subject_ids(index)

    # Реальные тоталы РФ из ручной выгрузки (CSV) — для известных продуктов.
    # Это «источник правды» для рынка/ОТП/доли; регионы масштабируются под тотал.
    ds_key = dataset.lookup(phrase) if client.demo_mode else None
    if ds_key:
        return _search_from_dataset(ds_key, index)

    try:
        # 1. Распределение по регионам РФ: рынок (база) и запрос «… ОТП».
        market_regions = filter_to_subjects(
            client.get_regions_distribution(market_phrase, devices=devices).get("results"), index)
        otp_regions = filter_to_subjects(
            client.get_regions_distribution(otp_phrase, devices=devices).get("results"), index)
        regions = _merge_regions(market_regions, otp_regions)

        # 2. Динамика частоты (рынок + ОТП) за выбранный период по всем субъектам РФ.
        market_dyn = _normalize_dynamics(client.dynamics_window(
            market_phrase, axis, region_id="ALL",
            all_region_ids=all_ids, devices=devices).get("results"))
        otp_dyn = _normalize_dynamics(client.dynamics_window(
            otp_phrase, axis, region_id="ALL",
            all_region_ids=all_ids, devices=devices).get("results"))

    except YandexError as exc:
        return jsonify({"error": str(exc)}), 502

    total_market = sum(r["market"] for r in regions)
    total_otp = sum(r["otp"] for r in regions)
    otp_share = round(total_otp / total_market * 100, 3) if total_market else 0.0

    return jsonify({
        "marketPhrase": market_phrase,
        "otpPhrase": otp_phrase,
        "demo": client.demo_mode,
        "totals": {
            "market": total_market,
            "otp": total_otp,
            "otpShare": otp_share,
            "leader": regions[0]["name"] if regions else "—",
        },
        "regions": regions,
        "dynamics": _pack_dynamics(axis, market_dyn, otp_dyn),
        "window": {"months": axis["months"], "labels": axis["labels"],
                   "period": axis["period"]},
        "excluded": {
            "federalDistricts": len(index["federal_districts"]),
            "note": "Федеральные округа и зарубежные регионы исключены.",
        },
    })


@app.route("/api/dynamics", methods=["POST"])
def dynamics_for_region():
    """Динамика частоты (рынок + ОТП) за выбранный период и регион.

    region == "ALL" — агрегат по всем субъектам РФ; иначе — один субъект.
    """
    payload = request.get_json(force=True, silent=True) or {}
    phrase = (payload.get("phrase") or "").strip()
    if not phrase:
        return jsonify({"error": "Не задана ключевая фраза"}), 400
    region_id = str(payload.get("region") or "ALL")
    devices = payload.get("devices") or None
    period = payload.get("period") or "PERIOD_MONTHLY"
    otp_phrase = phrase + " ОТП"
    axis = period_axis(period)

    client = WordstatClient()
    index = get_subject_index(client)
    all_ids = all_subject_ids(index)

    # Известный продукт из CSV — отдаём реальный месячный ряд (масштаб по региону).
    ds_key = dataset.lookup(phrase) if client.demo_mode else None
    if ds_key:
        return _dynamics_from_dataset(ds_key, region_id, index)

    try:
        market_dyn = _normalize_dynamics(client.dynamics_window(
            phrase, axis, region_id=region_id,
            all_region_ids=all_ids, devices=devices).get("results"))
        otp_dyn = _normalize_dynamics(client.dynamics_window(
            otp_phrase, axis, region_id=region_id,
            all_region_ids=all_ids, devices=devices).get("results"))
    except YandexError as exc:
        return jsonify({"error": str(exc)}), 502

    return jsonify({
        "region": region_id,
        "dynamics": _pack_dynamics(axis, market_dyn, otp_dyn),
        "window": {"months": axis["months"], "labels": axis["labels"],
                   "period": axis["period"]},
    })


@app.route("/api/export", methods=["POST"])
def export_excel():
    payload = request.get_json(force=True, silent=True) or {}
    phrase = (payload.get("phrase") or "запрос").strip()
    regions = payload.get("regions") or []
    dynamics = payload.get("dynamics") or []

    client = WordstatClient()
    window = last_full_months()
    region_ids = [str(r.get("id")) for r in regions if r.get("id") is not None]
    try:
        matrix = client.monthly_matrix(phrase, region_ids, window)
    except YandexError:
        matrix = {}

    buffer = _build_workbook(phrase, regions, dynamics, window, matrix)
    filename = "wordstat_%s.xlsx" % _safe_name(phrase)
    return send_file(
        buffer,
        as_attachment=True,
        download_name=filename,
        mimetype="application/vnd.openxmlformats-officedocument."
                  "spreadsheetml.sheet",
    )


# ----------------------------------------------------------- helpers ---
def _search_from_dataset(ds_key, index):
    """Ответ /api/search на реальных тоталах РФ (CSV). Регионы масштабируются
    так, что их сумма = реальный тотал; доля ОТП = ОТП / рынок."""
    win = dataset.window(ds_key, 12)
    market_total = win["marketLatest"]
    otp_total = win["otpLatest"]
    market_regions, otp_regions = dataset.regional_split(
        ds_key, market_total, otp_total, index)
    regions = _merge_regions(market_regions, otp_regions)
    otp_share = round(otp_total / market_total * 100, 3) if market_total else 0.0
    product = dataset.product(ds_key)
    return jsonify({
        "marketPhrase": product["base"],
        "otpPhrase": product["otpName"],
        "demo": True,
        "source": "csv",
        "totals": {
            "market": market_total,
            "otp": otp_total,
            "otpShare": otp_share,
            "leader": regions[0]["name"] if regions else "—",
            "monthLabel": win["labels"][-1] if win["labels"] else "",
        },
        "regions": regions,
        "dynamics": {"labels": win["labels"], "market": win["market"], "otp": win["otp"]},
        "window": {"months": win["keys"], "labels": win["labels"],
                   "period": "PERIOD_MONTHLY"},
        "excluded": {
            "federalDistricts": len(index["federal_districts"]),
            "note": "Тотал РФ по ручной выгрузке (CSV); регионы смоделированы под тотал.",
        },
    })


def _dynamics_from_dataset(ds_key, region_id, index):
    """Месячная динамика (рынок + ОТП) из CSV; для конкретного субъекта ряд
    масштабируется на долю региона в тотале."""
    win = dataset.window(ds_key, 12)
    market, otp = win["market"], win["otp"]
    if region_id != "ALL":
        fm, fo = dataset.region_fractions(
            ds_key, region_id, win["marketLatest"], win["otpLatest"], index)
        market = [int(round(v * fm)) for v in market]
        otp = [int(round(v * fo)) for v in otp]
    return jsonify({
        "region": region_id,
        "dynamics": {"labels": win["labels"], "market": market, "otp": otp},
        "window": {"months": win["keys"], "labels": win["labels"],
                   "period": "PERIOD_MONTHLY"},
    })


def _merge_regions(market_regions, otp_regions):
    """Сводит распределения рынка и ОТП в строки по субъектам РФ.

    Для каждого региона: market/otp (абсолют), marketShare/otpShare (доля
    внутри своего набора) и penetration — доля ОТП от рынка в этом регионе.
    """
    otp_by_id = {r["id"]: r for r in otp_regions}
    total_m = sum(r["count"] for r in market_regions) or 1
    total_o = sum(r["count"] for r in otp_regions) or 1
    rows = []
    for m in market_regions:
        mc = m["count"]
        oc = int(otp_by_id.get(m["id"], {}).get("count", 0))
        rows.append({
            "id": m["id"],
            "name": m["name"],
            "market": mc,
            "otp": oc,
            "marketShare": round(mc / total_m * 100, 2),
            "otpShare": round(oc / total_o * 100, 2),
            "penetration": round(oc / mc * 100, 2) if mc else 0.0,
            "affinityIndex": round(m.get("affinityIndex", 0)),
        })
    rows.sort(key=lambda r: r["market"], reverse=True)
    return rows


def _pack_dynamics(axis, market, otp):
    """Упаковка двух рядов динамики под общие подписи периода."""
    return {
        "labels": axis["labels"],
        "market": [d["count"] for d in market],
        "otp": [d["count"] for d in otp],
    }


def _normalize_dynamics(results):
    out = []
    for item in results or []:
        out.append({
            "date": item.get("date"),
            "count": _safe_int(item.get("count")),
            "share": _safe_float(item.get("share")),
        })
    out.sort(key=lambda r: r["date"] or "")
    return out


def _normalize_top(top_raw):
    def conv(rows):
        return [{"phrase": r.get("phrase"), "count": _safe_int(r.get("count"))}
                for r in rows or []]
    return {
        "totalCount": _safe_int(top_raw.get("totalCount")),
        "results": conv(top_raw.get("results")),
        "associations": conv(top_raw.get("associations")),
    }


def _build_workbook(phrase, regions, dynamics, window, matrix):
    from openpyxl import Workbook
    from openpyxl.chart import BarChart, LineChart, Reference
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    month_labels = (window or {}).get("labels") or []
    month_keys = (window or {}).get("months") or []
    matrix = matrix or {}

    wb = Workbook()
    header_fill = PatternFill("solid", fgColor="7AB829")   # фирменный зелёный ОТП
    header_font = Font(bold=True, color="FFFFFF")

    def style_header(ws, row, ncols):
        for c in range(1, ncols + 1):
            cell = ws.cell(row=row, column=c)
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(horizontal="center", wrap_text=True)

    # --- Лист 1: Регионы (субъекты РФ) ---
    ws = wb.active
    ws.title = "Регионы РФ"
    headers = ["Регион (субъект РФ)", "Показов (рынок)", "Показов (ОТП)",
               "Доля ОТП от рынка, %", "Доля рынка, %",
               "Индекс соответствия"] + month_labels
    ws.append(headers)
    style_header(ws, 1, len(headers))
    for r in regions:
        rid = str(r.get("id"))
        monthly = matrix.get(rid, [None] * len(month_keys))
        row = [r.get("name"), r.get("market"), r.get("otp"),
               r.get("penetration"), r.get("marketShare"),
               r.get("affinityIndex")]
        row.extend(monthly)
        ws.append(row)

    ws.column_dimensions["A"].width = 38
    for col, w in (("B", 16), ("C", 15), ("D", 18), ("E", 14), ("F", 18)):
        ws.column_dimensions[col].width = w
    for i in range(len(month_labels)):
        ws.column_dimensions[get_column_letter(7 + i)].width = 11
    ws.freeze_panes = "B2"

    # Диаграмма топ-15 регионов: рынок vs ОТП (col B, C).
    if regions:
        n = min(len(regions), 15)
        chart = BarChart()
        chart.title = "Топ-15 регионов: рынок и ОТП"
        chart.type = "bar"
        chart.height = 12
        chart.width = 22
        data = Reference(ws, min_col=2, max_col=3, min_row=1, max_row=1 + n)
        cats = Reference(ws, min_col=1, min_row=2, max_row=1 + n)
        chart.add_data(data, titles_from_data=True)
        chart.set_categories(cats)
        anchor = get_column_letter(len(headers) + 2) + "2"
        ws.add_chart(chart, anchor)

    # --- Лист 2: Динамика (рынок + ОТП) ---
    labels = (dynamics or {}).get("labels") or []
    market = (dynamics or {}).get("market") or []
    otp = (dynamics or {}).get("otp") or []
    ws2 = wb.create_sheet("Динамика")
    ws2.append(["Период", "Показов (рынок)", "Показов (ОТП)"])
    style_header(ws2, 1, 3)
    for i, lab in enumerate(labels):
        ws2.append([lab,
                    market[i] if i < len(market) else None,
                    otp[i] if i < len(otp) else None])
    ws2.column_dimensions["A"].width = 16
    ws2.column_dimensions["B"].width = 16
    ws2.column_dimensions["C"].width = 16
    if labels:
        line = LineChart()
        line.title = "Динамика показов: рынок и ОТП"
        line.height = 10
        line.width = 24
        data = Reference(ws2, min_col=2, max_col=3, min_row=1, max_row=1 + len(labels))
        cats = Reference(ws2, min_col=1, min_row=2, max_row=1 + len(labels))
        line.add_data(data, titles_from_data=True)
        line.set_categories(cats)
        ws2.add_chart(line, "E2")

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return buffer


def _safe_int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _safe_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _safe_name(phrase):
    keep = [c if c.isalnum() else "_" for c in phrase.lower()]
    return ("".join(keep)[:40]) or "export"


def _resolve_port():
    """Порт: --port N → переменная PORT → 5000 по умолчанию.

    На macOS порт 5000 по умолчанию занимает AirPlay (IPv6 ::1), поэтому
    возможность переопределить порт особенно полезна локально.
    """
    argv = sys.argv
    if "--port" in argv:
        try:
            return int(argv[argv.index("--port") + 1])
        except (IndexError, ValueError):
            pass
    return int(os.environ.get("PORT", "5000"))


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=_resolve_port(), debug=False)
