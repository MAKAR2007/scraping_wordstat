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

from months import last_full_months, last_n_months


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
from regions import build_subject_index
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
    client = WordstatClient()
    index = get_subject_index(client)

    try:
        _key, base, otp_name, hist, year, _my, _oy = \
            _phrase_history(phrase, devices, client, index)
    except YandexError as exc:
        return jsonify({"error": str(exc)}), 502

    # Регионы (числа/доли/лидеры) считаются на клиенте под выбранный период,
    # поэтому отдаём только стабильный список субъектов РФ и полную историю.
    subjects = [{"id": sid, "name": name}
                for sid, name in index["subjects"].items()]

    return jsonify({
        "marketPhrase": base,
        "otpPhrase": otp_name,
        "demo": client.demo_mode,
        "year": year,
        "subjects": subjects,
        "dynamics": hist,            # полная месячная история {keys,labels,market,otp}
        "excluded": {
            "federalDistricts": len(index["federal_districts"]),
            "note": "Федеральные округа и зарубежные регионы исключены.",
        },
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
# Доли устройств (демо): «Все устройства» = полный тотал (совпадает с CSV),
# остальные — детерминированная доля рынка/ОТП, чтобы селектор реально менял
# цифры. ОТП слегка иначе распределён по устройствам, чем рынок.
_DEVICE_FACTORS = {
    "DEVICE_ALL": (1.0, 1.0),
    "DEVICE_DESKTOP": (0.42, 0.36),
    "DEVICE_PHONE": (0.50, 0.57),
    "DEVICE_TABLET": (0.08, 0.07),
}


def _device_factors(devices):
    if not devices:
        return (1.0, 1.0)
    return _DEVICE_FACTORS.get(str(devices[0]).upper(), (1.0, 1.0))


def _phrase_history(phrase, devices, client, index):
    """Единый источник данных по фразе.

    Возвращает (key, base, otpName, hist, year, market_year, otp_year), где
    hist — полная месячная история {keys,labels,market,otp}, а *_year — суммы
    за последний полный календарный год. Известные продукты берутся из CSV
    (реальные тоталы РФ), остальные — синтетика по 48 месяцам. Выбор устройства
    масштабирует объёмы (на «Все устройства» тоталы совпадают с выгрузкой).
    """
    mf, of = _device_factors(devices)
    ds_key = dataset.lookup(phrase) if client.demo_mode else None
    if ds_key:
        product = dataset.product(ds_key)
        h = dataset.history(ds_key)
        keys, labels = h["keys"], h["labels"]
        raw_market, raw_otp = h["market"], h["otp"]
        key, base, otp_name = ds_key, product["base"], product["otpName"]
    else:
        otp_phrase = phrase + " ОТП"
        win = last_n_months(48)
        keys, labels = win["keys"], win["labels"]
        raw_market = client.monthly_history(phrase, keys)
        raw_otp = client.monthly_history(otp_phrase, keys)
        key, base, otp_name = phrase, phrase, otp_phrase

    market = [int(round(v * mf)) for v in raw_market]
    otp = [int(round(v * of)) for v in raw_otp]
    hist = {"keys": keys, "labels": labels, "market": market, "otp": otp}
    year, my, oy = dataset.year_totals_from_series(keys, market, otp)
    return key, base, otp_name, hist, year, my, oy


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
            "penetration": round(oc / mc * 100, 3) if mc else 0.0,
            "affinityIndex": round(m.get("affinityIndex", 0)),
        })
    rows.sort(key=lambda r: r["market"], reverse=True)
    return rows


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
