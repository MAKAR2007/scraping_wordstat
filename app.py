# -*- coding: utf-8 -*-
"""
Веб-дашборд статистики ключевых слов Yandex Wordstat.

Бэкенд проксирует запросы к Yandex Search API, строго разбивает данные по
субъектам РФ (федеральные округа исключаются) и формирует выгрузку в Excel.
"""

import io
import os

from flask import Flask, jsonify, request, send_file, send_from_directory

from months import last_full_months


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
    return send_from_directory("static", "index.html")


@app.route("/api/status")
def status():
    client = WordstatClient()
    return jsonify({"demo": client.demo_mode})


@app.route("/api/search", methods=["POST"])
def search():
    payload = request.get_json(force=True, silent=True) or {}
    phrase = (payload.get("phrase") or "").strip()
    if not phrase:
        return jsonify({"error": "Не задана ключевая фраза"}), 400

    devices = payload.get("devices") or None
    window = last_full_months()

    client = WordstatClient()
    index = get_subject_index(client)

    try:
        # 1. Распределение по регионам -> только субъекты РФ.
        dist_raw = client.get_regions_distribution(phrase, devices=devices)
        regions = filter_to_subjects(dist_raw.get("results"), index)

        # 2. Динамика частоты за последние 12 полных месяцев (по всем субъектам РФ).
        dyn_raw = client.dynamics_window(
            phrase, window, region_id="ALL",
            all_region_ids=all_subject_ids(index), devices=devices,
        )
        dynamics = _normalize_dynamics(dyn_raw.get("results"))

    except YandexError as exc:
        return jsonify({"error": str(exc)}), 502

    total = sum(r["count"] for r in regions)
    return jsonify({
        "phrase": phrase,
        "demo": client.demo_mode,
        "totalCount": total,
        "regionsCount": len(regions),
        "regions": regions,
        "dynamics": dynamics,
        "window": {"months": window["months"], "labels": window["labels"]},
        "excluded": {
            "federalDistricts": len(index["federal_districts"]),
            "note": "Федеральные округа и зарубежные регионы исключены.",
        },
    })


@app.route("/api/dynamics", methods=["POST"])
def dynamics_for_region():
    """Динамика частоты за последние 12 полных месяцев по выбранному региону.

    region == "ALL" — агрегат по всем субъектам РФ; иначе — один субъект.
    """
    payload = request.get_json(force=True, silent=True) or {}
    phrase = (payload.get("phrase") or "").strip()
    if not phrase:
        return jsonify({"error": "Не задана ключевая фраза"}), 400
    region_id = str(payload.get("region") or "ALL")
    devices = payload.get("devices") or None

    client = WordstatClient()
    index = get_subject_index(client)
    window = last_full_months()
    try:
        raw = client.dynamics_window(
            phrase, window, region_id=region_id,
            all_region_ids=all_subject_ids(index), devices=devices,
        )
    except YandexError as exc:
        return jsonify({"error": str(exc)}), 502

    return jsonify({
        "region": region_id,
        "dynamics": _normalize_dynamics(raw.get("results")),
        "window": {"months": window["months"], "labels": window["labels"]},
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
    header_fill = PatternFill("solid", fgColor="52AE30")   # фирменный зелёный ОТП
    header_font = Font(bold=True, color="FFFFFF")

    def style_header(ws, row, ncols):
        for c in range(1, ncols + 1):
            cell = ws.cell(row=row, column=c)
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(horizontal="center", wrap_text=True)

    # --- Лист 1: Регионы (субъекты РФ) ---
    # Без заголовочных строк и без столбца с номерами: первая строка — шапка.
    ws = wb.active
    ws.title = "Регионы РФ"
    headers = ["Регион (субъект РФ)", "Показов за месяц", "Доля, %",
               "Индекс соответствия"] + month_labels
    ws.append(headers)
    style_header(ws, 1, len(headers))
    for r in regions:
        rid = str(r.get("id"))
        monthly = matrix.get(rid, [None] * len(month_keys))
        row = [r.get("name"), r.get("count"),
               round(r.get("share", 0), 3), r.get("affinityIndex")]
        row.extend(monthly)
        ws.append(row)

    ws.column_dimensions["A"].width = 40
    ws.column_dimensions["B"].width = 16
    ws.column_dimensions["C"].width = 10
    ws.column_dimensions["D"].width = 18
    for i in range(len(month_labels)):
        ws.column_dimensions[get_column_letter(5 + i)].width = 11
    ws.freeze_panes = "B2"

    # Диаграмма топ-15 регионов (шапка в строке 1, регион — col A, показы — col B).
    if regions:
        n = min(len(regions), 15)
        chart = BarChart()
        chart.title = "Топ регионов по числу показов"
        chart.type = "bar"
        chart.height = 12
        chart.width = 22
        data = Reference(ws, min_col=2, min_row=1, max_row=1 + n)
        cats = Reference(ws, min_col=1, min_row=2, max_row=1 + n)
        chart.add_data(data, titles_from_data=True)
        chart.set_categories(cats)
        chart.legend = None
        anchor = get_column_letter(len(headers) + 2) + "2"
        ws.add_chart(chart, anchor)

    # --- Лист 2: Динамика (последние 12 полных месяцев) ---
    ws2 = wb.create_sheet("Динамика")
    ws2.append(["Месяц", "Показов"])
    style_header(ws2, 1, 2)
    for d in dynamics:
        ws2.append([(d.get("date") or "")[:7], d.get("count")])
    ws2.column_dimensions["A"].width = 14
    ws2.column_dimensions["B"].width = 14
    if dynamics:
        line = LineChart()
        line.title = "Динамика показов"
        line.height = 10
        line.width = 24
        data = Reference(ws2, min_col=2, min_row=1, max_row=1 + len(dynamics))
        cats = Reference(ws2, min_col=1, min_row=2, max_row=1 + len(dynamics))
        line.add_data(data, titles_from_data=True)
        line.set_categories(cats)
        line.legend = None
        ws2.add_chart(line, "D2")

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


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
