# -*- coding: utf-8 -*-
"""
Клиент Yandex Wordstat (Search API) + генератор демо-данных.

Документация:
  https://aistudio.yandex.ru/docs/ru/search-api/concepts/wordstat.html

Базовый URL: https://searchapi.api.cloud.yandex.net/v2/wordstat
Аутентификация:
  Authorization: Api-Key <ключ>      — переменная окружения YANDEX_API_KEY
  Authorization: Bearer <IAM-токен>  — переменная окружения YANDEX_IAM_TOKEN
folderId: переменная окружения YANDEX_FOLDER_ID

Если ключ/токен не заданы — клиент работает в демо-режиме и возвращает
правдоподобные синтетические данные (полезно для интерфейса и выгрузки без
реальных кредов).
"""

import hashlib
import json
import math
import os
import time
import urllib.error
import urllib.request

from regions import RUSSIA_TREE, build_subject_index

BASE_URL = "https://searchapi.api.cloud.yandex.net/v2/wordstat"
TIMEOUT = 30

# Wordstat API ограничивает частоту запросов (при бурсте отдаёт 403, а не 429),
# поэтому держим паузу между вызовами и ретраим транзиентные ошибки.
_MIN_INTERVAL = 0.35
_RETRIES = 3
_last_call = {"t": 0.0}


class YandexError(RuntimeError):
    pass


class WordstatClient:
    def __init__(self):
        self.api_key = os.environ.get("YANDEX_API_KEY", "").strip()
        self.iam_token = os.environ.get("YANDEX_IAM_TOKEN", "").strip()
        self.folder_id = os.environ.get("YANDEX_FOLDER_ID", "").strip()

    @property
    def demo_mode(self):
        return not (self.api_key or self.iam_token)

    # ---------------------------------------------------------------- HTTP --
    def _auth_header(self):
        if self.api_key:
            return "Api-Key " + self.api_key
        if self.iam_token:
            return "Bearer " + self.iam_token
        raise YandexError("Не заданы YANDEX_API_KEY или YANDEX_IAM_TOKEN")

    def _post(self, path, body):
        body = dict(body)
        if self.folder_id:
            body.setdefault("folderId", self.folder_id)
        data = json.dumps(body).encode("utf-8")

        last_err = None
        for attempt in range(_RETRIES + 1):
            wait = _MIN_INTERVAL - (time.monotonic() - _last_call["t"])
            if wait > 0:
                time.sleep(wait)
            req = urllib.request.Request(
                BASE_URL + path,
                data=data,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": self._auth_header(),
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                    _last_call["t"] = time.monotonic()
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                _last_call["t"] = time.monotonic()
                detail = exc.read().decode("utf-8", "replace")
                last_err = YandexError("Ошибка API %s: %s" % (exc.code, detail))
                # 403/429/5xx при бурсте — транзиентные, пробуем ещё раз.
                if exc.code in (403, 429, 500, 502, 503, 504) and attempt < _RETRIES:
                    time.sleep(1.0 + attempt)
                    continue
                raise last_err
            except urllib.error.URLError as exc:
                last_err = YandexError("Сетевая ошибка: %s" % exc.reason)
                if attempt < _RETRIES:
                    time.sleep(1.0 + attempt)
                    continue
                raise last_err
        raise last_err

    # ----------------------------------------------------------- methods ---
    def get_regions_tree(self):
        if self.demo_mode:
            return {"regions": [RUSSIA_TREE]}
        return self._post("/getRegionsTree", {})

    def get_regions_distribution(self, phrase, devices=None):
        """region=REGION_REGIONS — распределение по регионам (субъектам)."""
        if self.demo_mode:
            return _demo_distribution(phrase, devices)
        body = {"phrase": phrase, "region": "REGION_REGIONS"}
        if devices:
            body["devices"] = devices
        return self._post("/regions", body)

    def get_dynamics(self, phrase, period, from_date, to_date=None,
                     regions=None, devices=None):
        if self.demo_mode:
            return _demo_dynamics(phrase, period, from_date, to_date)
        body = {"phrase": phrase, "period": period, "fromDate": from_date}
        if to_date:
            body["toDate"] = to_date
        if regions:
            body["regions"] = regions[:100]
        if devices:
            body["devices"] = devices
        return self._post("/dynamics", body)

    def get_top(self, phrase, num_phrases=20, regions=None, devices=None):
        if self.demo_mode:
            return _demo_top(phrase, num_phrases)
        body = {"phrase": phrase, "numPhrases": num_phrases}
        if regions:
            body["regions"] = regions[:100]
        if devices:
            body["devices"] = devices
        return self._post("/topRequests", body)

    # -------------------------------------------------- динамика по окну ---
    def dynamics_window(self, phrase, window, region_id="ALL",
                        all_region_ids=None, devices=None):
        """Динамика частоты за окно (месяц/неделя/день — см. window["period"]).

        region_id == "ALL" — агрегат по всем субъектам РФ (all_region_ids),
        иначе — по одному выбранному субъекту.
        """
        if self.demo_mode:
            seed_key = phrase if region_id == "ALL" else "%s|%s" % (phrase, region_id)
            return {"results": _demo_series(seed_key, window["months"], devices)}
        period = window.get("period", "PERIOD_MONTHLY")
        if region_id == "ALL":
            regions = all_region_ids
        else:
            regions = [region_id]
        return self.get_dynamics(
            phrase, period, window["fromDate"], window["toDate"],
            regions=regions, devices=devices,
        )

    def monthly_history(self, phrase, keys, devices=None):
        """Месячный ряд частот по списку ключей ['YYYY-MM', ...] (агрегат РФ).

        Для неизвестных фраз — синтетика; в рабочем режиме — помесячный API.
        API требует, чтобы toDate был ПОСЛЕДНИМ днём месяца.
        """
        import calendar
        y, m = int(keys[-1][:4]), int(keys[-1][5:7])
        win = {"months": keys, "period": "PERIOD_MONTHLY",
               "fromDate": keys[0] + "-01T00:00:00Z",
               "toDate": "%04d-%02d-%02dT00:00:00Z" % (y, m, calendar.monthrange(y, m)[1])}
        res = self.dynamics_window(phrase, win, region_id="ALL",
                                   all_region_ids=None, devices=devices)
        by = {(r.get("date") or "")[:7]: _int(r.get("count")) for r in res.get("results") or []}
        return [by.get(k, 0) for k in keys]

    def monthly_matrix(self, phrase, region_ids, window, devices=None):
        """Матрица «регион × месяц» за окно последних 12 полных месяцев.

        :return: {region_id: [count_месяц1, ..., count_месяц12]} в порядке
                 window["months"].
        """
        months = window["months"]
        matrix = {}
        for rid in region_ids:
            if self.demo_mode:
                points = _demo_series("%s|%s" % (phrase, rid), months, devices)
            else:
                resp = self.get_dynamics(
                    phrase, "PERIOD_MONTHLY", window["fromDate"],
                    window["toDate"], regions=[rid], devices=devices,
                )
                points = resp.get("results") or []
            by_month = {}
            for p in points:
                by_month[(p.get("date") or "")[:7]] = _int(p.get("count"))
            matrix[rid] = [by_month.get(mo, 0) for mo in months]
        return matrix


# ---------------------------------------------------------- демо-данные ---
def _seed(text):
    return int(hashlib.md5(text.encode("utf-8")).hexdigest()[:8], 16)


# Доля устройства в общем объёме показов (демо-режим). Позволяет селектору
# «Устройства» давать видимо разные данные.
_DEVICE_FACTOR = {
    "DEVICE_ALL": 1.0,
    "DEVICE_DESKTOP": 0.42,
    "DEVICE_PHONE": 0.50,
    "DEVICE_TABLET": 0.08,
}


def _device_factor(devices):
    if not devices:
        return 1.0
    return _DEVICE_FACTOR.get(str(devices[0]).upper(), 1.0)


def _demo_distribution(phrase, devices=None):
    """Возвращает «сырое» распределение в формате API, включая федеральные
    округа, Россию и пару зарубежных стран — чтобы фильтрация субъектов была
    наглядно проверяемой (всё лишнее отсекается в regions.filter_to_subjects).

    Запрос «… ОТП» строится как детерминированная доля (5–45%) от базовой
    фразы по каждому региону — так доля ОТП всегда ≤ 100% и правдоподобна.
    Селектор устройств масштабирует объёмы (_device_factor).
    """
    idx = build_subject_index({"regions": [RUSSIA_TREE]})
    is_otp = phrase.endswith(" ОТП")
    base_phrase = phrase[:-4] if is_otp else phrase
    base = _seed(base_phrase)
    factor = _device_factor(devices)
    results = []

    # Шум: Россия целиком + зарубежные страны — должны быть отфильтрованы.
    results.append({"region": "225", "count": "1000000", "share": "100",
                    "affinityIndex": "100"})
    results.append({"region": "149", "count": "50000", "share": "5",
                    "affinityIndex": "60"})   # Беларусь
    results.append({"region": "159", "count": "40000", "share": "4",
                    "affinityIndex": "55"})   # Казахстан

    total = 0
    raw = []
    for i, (sid, name) in enumerate(idx["subjects"].items()):
        # Базовая (рыночная) частота — детерминированная по фразе и региону.
        val = (base // (i + 3)) % 90000 + (len(name) * 137) % 5000 + 200
        if is_otp:
            # Доля ОТП по региону: 0.3–3.0% от рыночной частоты (как в реальности —
            # бренд занимает малую долю рынка; детерминированно по фразе/региону).
            frac = (_seed(base_phrase + sid) % 28 + 3) / 1000.0
            val = max(0, int(val * frac))
        val = max(1, int(val * factor))
        raw.append((sid, val))
        total += val

    # Строки федеральных округов как шум — отсеются фильтром субъектов.
    for fd_id, fd_name in idx["federal_districts"].items():
        results.append({"region": fd_id, "count": "777777", "share": "9",
                        "affinityIndex": "80"})

    for sid, val in raw:
        share = round(val / total * 100, 3) if total else 0
        affinity = 50 + (val % 120)
        results.append({"region": sid, "count": str(val),
                        "share": str(share), "affinityIndex": str(affinity)})

    return {"results": results}


def _int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _demo_series(seed_key, keys, devices=None):
    """Детерминированный временной ряд по списку ключей.

    Ключ — "YYYY-MM" (месяц) либо "YYYY-MM-DD" (неделя/день). Сезонность
    зависит от seed_key (фраза и/или регион). Запрос «… ОТП» наследует форму
    рынка, но в меньшем масштабе (seed по базовой фразе + множитель доли).
    Селектор устройств масштабирует объёмы.
    """
    is_otp = "ОТП" in seed_key
    base_key = seed_key.replace(" ОТП", "")
    base = _seed(base_key)
    amp = base % 9000 + 3000          # амплитуда сезонных колебаний
    level = base % 40000 + 8000       # базовый уровень
    scale = ((_seed(base_key + "otp") % 28 + 3) / 1000.0) if is_otp else 1.0
    factor = _device_factor(devices)
    results = []
    for i, key in enumerate(keys):
        season = int(amp * (1 + math.sin((i + base % 12) / 1.9)))
        count = max(200, level + season + (base // (i + 3)) % 6000)
        count = max(20, int(count * scale * factor))
        date = key + "-01T00:00:00Z" if len(key) == 7 else key + "T00:00:00Z"
        results.append({"date": date, "count": str(count), "share": "0"})
    return results


def _demo_dynamics(phrase, period, from_date, to_date):
    base = _seed(phrase + (period or ""))
    points = 12 if (period or "").endswith("MONTHLY") else 8
    results = []
    year = 2025
    for m in range(points):
        count = (base // (m + 2)) % 80000 + 5000 + (m * 1500)
        month = (m % 12) + 1
        results.append({
            "date": "%04d-%02d-01T00:00:00Z" % (year, month),
            "count": str(count),
            "share": str(round((count % 1000) / 100.0, 2)),
        })
    return {"results": results}


def _demo_top(phrase, num_phrases):
    base = _seed(phrase)
    suffixes = ["купить", "цена", "отзывы", "официальный сайт", "онлайн",
                "москва", "недорого", "каталог", "доставка", "2025",
                "что это", "своими руками", "инструкция", "форум", "видео",
                "бесплатно", "скачать", "рейтинг", "сравнение", "акции"]
    results = []
    for i in range(min(num_phrases, len(suffixes))):
        cnt = (base // (i + 2)) % 60000 + 1000
        results.append({"phrase": "%s %s" % (phrase, suffixes[i]),
                        "count": cnt})
    results.sort(key=lambda r: r["count"], reverse=True)

    # Ассоциации — реалистичные похожие запросы, строятся из ключевых слов
    # фразы с популярными модификаторами (как в настоящем Wordstat).
    words = [w for w in phrase.lower().split() if len(w) > 2]
    core = words[-1] if words else phrase   # самое информативное слово
    assoc_templates = [
        "{core} 2025",
        "{core} лучший",
        "лучший {core}",
        "рейтинг {core}",
        "{core} для дома",
        "{core} для работы",
        "топ {core}",
        "выбрать {core}",
        "{core} характеристики",
        "{core} б/у",
        "новый {core}",
        "{core} какой лучше",
        "{core} цена качество",
        "дешевый {core}",
        "{core} отзывы 2025",
    ]
    assoc = []
    for i, tmpl in enumerate(assoc_templates):
        cnt = (base // (i + 5)) % 30000 + 800
        assoc.append({"phrase": tmpl.format(core=core), "count": cnt})
    assoc.sort(key=lambda r: r["count"], reverse=True)

    total = sum(r["count"] for r in results) * 3
    return {"totalCount": total, "results": results, "associations": assoc}
