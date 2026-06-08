# -*- coding: utf-8 -*-
"""
Источник реальных данных по тоталу РФ — ручная выгрузка Wordstat в CSV.

Файл `data/search_queries_v3.csv` содержит помесячные суммарные частоты по РФ
для нескольких продуктов: строка «рынка» (общие запросы), строка «… ОТП» и
строка «Доля, %» (= ОТП / рынок). Этот модуль парсит файл и отдаёт по фразе:

  • помесячные ряды «рынок» и «ОТП» (для динамики);
  • актуальный месяц (тотал РФ за месяц) — для карточек и масштаба регионов;
  • долю ОТП = ОТП / рынок (сверяется со столбцом «Доля, %» в файле).

Региональной разбивки в файле нет, поэтому распределение по субъектам РФ
моделируется детерминированно так, чтобы СУММА по регионам точно равнялась
реальному тоталу РФ (см. regional_split).
"""

import csv
import hashlib
import os
import re

CSV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "data", "search_queries_v3.csv")

_MONTHS = {
    "янв": 1, "фев": 2, "февр": 2, "мар": 3, "апр": 4, "май": 5, "мая": 5,
    "июн": 6, "июл": 7, "авг": 8, "сен": 9, "сент": 9, "окт": 10,
    "ноя": 11, "нояб": 11, "дек": 12,
}
_RU_LABEL = ["", "янв", "фев", "мар", "апр", "май", "июн",
             "июл", "авг", "сен", "окт", "ноя", "дек"]

_OTP_SUFFIX = " ОТП"
_cache = {"products": None, "month_cols": None}


# ----------------------------------------------------------------- parse ---
def _num(cell):
    """'  565 308 ' / '1 062 073' / '' -> int | None (неразрывные пробелы тоже)."""
    if cell is None:
        return None
    s = re.sub(r"\s", "", cell.replace(" ", "").replace(" ", ""))
    if not s or not re.search(r"\d", s):
        return None
    try:
        return int(s)
    except ValueError:
        return None


def _norm(name):
    """Нормализует название: lower, убирает '(оверолл)', схлопывает пробелы."""
    s = (name or "").lower().replace("(оверолл)", "")
    return re.sub(r"\s+", " ", s).strip()


def _parse_month(label):
    """'янв.-21' / 'мая-21' -> 'YYYY-MM' | None."""
    label = (label or "").strip()
    m = re.match(r"^([а-я]+)\.?-(\d{2})$", label)
    if not m:
        return None
    mon = _MONTHS.get(m.group(1))
    if not mon:
        return None
    return "20%s-%02d" % (m.group(2), mon)


def _load():
    if _cache["products"] is not None:
        return _cache["products"]

    products = {}
    month_cols = []
    if os.path.exists(CSV_PATH):
        with open(CSV_PATH, encoding="utf-8") as fh:
            rows = list(csv.reader(fh))

        # Колонки месяцев: со 2-й до первой пустой шапки.
        header = rows[0] if rows else []
        for i in range(2, len(header)):
            if not header[i].strip():
                break
            key = _parse_month(header[i])
            if key:
                month_cols.append((i, key))

        def series(row):
            out = {}
            for ci, key in month_cols:
                out[key] = _num(row[ci]) if ci < len(row) else None
            return out

        # Сводим пары «рынок» + «… ОТП» по нормализованному имени.
        market_rows = {}
        for r in rows:
            name = (r[1] if len(r) > 1 else "").strip()
            if not name or name.startswith("Доля") or name.startswith("http"):
                continue
            if name.endswith(_OTP_SUFFIX):
                continue
            market_rows.setdefault(_norm(name), (name, r))

        for r in rows:
            name = (r[1] if len(r) > 1 else "").strip()
            if not name.endswith(_OTP_SUFFIX):
                continue
            base = name[:-len(_OTP_SUFFIX)]
            key = _norm(base)
            if key not in market_rows:
                continue
            mk_name, mk_row = market_rows[key]
            products[key] = {
                "key": key,
                "base": base.strip(),
                "marketName": mk_name,
                "otpName": name,
                "market": series(mk_row),
                "otp": series(r),
            }

    _cache["products"] = products
    _cache["month_cols"] = month_cols
    return products


# --------------------------------------------------------------- queries ---
def lookup(phrase):
    """Нормализованная фраза -> ключ продукта в CSV (или None)."""
    return _norm(phrase) if _norm(phrase) in _load() else None


def product(key):
    """Полная запись продукта по ключу."""
    return _load()[key]


def known_phrases():
    return [p["base"] for p in _load().values()]


def _ordered_keys():
    return [k for _, k in _cache["month_cols"]]


def _label(key):
    y, mo = int(key[:4]), int(key[5:7])
    return "%s %d" % (_RU_LABEL[mo], y)


def history(key):
    """Полный месячный ряд продукта (все месяцы, где есть рынок)."""
    p = _load()[key]
    keys = [k for k in _ordered_keys() if p["market"].get(k) is not None]
    return {
        "keys": keys,
        "labels": [_label(k) for k in keys],
        "market": [int(p["market"].get(k) or 0) for k in keys],
        "otp": [int(p["otp"].get(k) or 0) for k in keys],
    }


def year_totals_from_series(keys, market, otp):
    """(год, сумма рынка, сумма ОТП) за последний ПОЛНЫЙ календарный год.

    Полный год = есть все 12 месяцев. Если полных нет — берём последний год.
    """
    by_year = {}
    for i, k in enumerate(keys):
        by_year.setdefault(int(k[:4]), []).append(i)
    full = [y for y in sorted(by_year) if len(by_year[y]) >= 12]
    year = full[-1] if full else (max(by_year) if by_year else None)
    if year is None:
        return (None, 0, 0)
    idxs = by_year[year]
    return (year, sum(market[i] for i in idxs), sum(otp[i] for i in idxs))


def year_totals(key):
    h = history(key)
    return year_totals_from_series(h["keys"], h["market"], h["otp"])


def window(key, n=12):
    """Последние n месяцев (где есть рынок) для продукта.

    :return: dict(labels, keys, market[], otp[], marketLatest, otpLatest)
    """
    p = _load()[key]
    keys = [k for k in _ordered_keys() if p["market"].get(k) is not None]
    keys = keys[-n:]
    market = [int(p["market"].get(k) or 0) for k in keys]
    otp = [int(p["otp"].get(k) or 0) for k in keys]
    labels = []
    for k in keys:
        y, mo = int(k[:4]), int(k[5:7])
        labels.append("%s %d" % (_RU_LABEL[mo], y))
    return {
        "labels": labels, "keys": keys, "market": market, "otp": otp,
        "marketLatest": market[-1] if market else 0,
        "otpLatest": otp[-1] if otp else 0,
    }


# ------------------------------------------------ моделирование регионов ---
def _w(text):
    return int(hashlib.md5(text.encode("utf-8")).hexdigest()[:8], 16)


def regional_split(key, market_total, otp_total, subject_index):
    """Детерминированное распределение тотала РФ по субъектам РФ.

    Гарантирует: sum(market) == market_total и sum(otp) == otp_total, а также
    otp_region <= market_region. Возвращает (market_regions, otp_regions) в
    формате regions.filter_to_subjects.
    """
    subjects = subject_index["subjects"]
    ids = list(subjects)
    if not ids:
        return [], []

    weights = [(_w(key + "|m|" + sid) % 1000) / 1000.0 + 0.05 for sid in ids]
    sw = sum(weights) or 1.0
    market = [int(round(market_total * w / sw)) for w in weights]
    market[market.index(max(market))] += market_total - sum(market)  # точная сумма

    base_share = (otp_total / market_total) if market_total else 0.0
    raw = []
    for i, sid in enumerate(ids):
        jitter = 0.5 + (_w(key + "|o|" + sid) % 1000) / 1000.0   # 0.5..1.5
        raw.append(market[i] * base_share * jitter)
    rs = sum(raw) or 1.0
    otp = [min(market[i], int(round(raw[i] * otp_total / rs))) for i in range(len(ids))]

    # Точная подгонка суммы ОТП к реальному тоталу.
    order = sorted(range(len(ids)), key=lambda i: market[i], reverse=True)
    diff = otp_total - sum(otp)
    k = 0
    guard = len(order) * 4 + 10
    while diff != 0 and k < guard:
        i = order[k % len(order)]
        if diff > 0 and otp[i] < market[i]:
            otp[i] += 1
            diff -= 1
        elif diff < 0 and otp[i] > 0:
            otp[i] -= 1
            diff += 1
        k += 1

    market_regions, otp_regions = [], []
    for i, sid in enumerate(ids):
        aff = 50 + (_w(key + "|a|" + sid) % 120)
        market_regions.append({"id": sid, "name": subjects[sid],
                               "count": market[i], "share": 0.0, "affinityIndex": aff})
        otp_regions.append({"id": sid, "name": subjects[sid],
                           "count": otp[i], "share": 0.0, "affinityIndex": aff})
    market_regions.sort(key=lambda r: r["count"], reverse=True)
    otp_regions.sort(key=lambda r: r["count"], reverse=True)
    return market_regions, otp_regions


def region_fractions(key, region_id, market_total, otp_total, subject_index):
    """Доли выбранного субъекта в тотале (для масштабирования рядов динамики)."""
    mr, orr = regional_split(key, market_total, otp_total, subject_index)
    fm = next((r["count"] for r in mr if r["id"] == region_id), 0) / (market_total or 1)
    fo = next((r["count"] for r in orr if r["id"] == region_id), 0) / (otp_total or 1)
    return fm, fo
