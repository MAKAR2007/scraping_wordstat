# -*- coding: utf-8 -*-
"""
Расчёт окна «последние 12 полных месяцев».

«Полный месяц» — это месяц, который уже полностью завершился. Текущий
(незавершённый) месяц в окно не входит. Например, если сегодня 29.05.2026,
то последний полный месяц — апрель 2026, а окно охватывает май 2025 — апрель
2026 включительно.
"""

import datetime as dt

RU_MONTHS = ["", "янв", "фев", "мар", "апр", "май", "июн",
             "июл", "авг", "сен", "окт", "ноя", "дек"]


def _last_day(year, month):
    if month == 12:
        nxt = dt.date(year + 1, 1, 1)
    else:
        nxt = dt.date(year, month + 1, 1)
    return (nxt - dt.timedelta(days=1)).day


def last_full_months(today=None, n=12):
    """Возвращает окно из n последних полных месяцев.

    :return: dict(
                months=["YYYY-MM", ...],   # по возрастанию, длина n
                labels=["май 2025", ...],  # подписи для UI/Excel
                fromDate="YYYY-MM-01T00:00:00Z",
                toDate="YYYY-MM-DDT00:00:00Z",  # последний день последнего полного месяца
             )
    """
    today = today or dt.date.today()
    first_of_current = today.replace(day=1)
    last_full_end = first_of_current - dt.timedelta(days=1)   # последний день прошлого месяца
    y, m = last_full_end.year, last_full_end.month

    months = []
    for i in range(n - 1, -1, -1):
        yy, mm = y, m - i
        while mm <= 0:
            mm += 12
            yy -= 1
        months.append("%04d-%02d" % (yy, mm))

    labels = []
    for ym in months:
        yy, mm = int(ym[:4]), int(ym[5:7])
        labels.append("%s %d" % (RU_MONTHS[mm], yy))

    sy, sm = int(months[0][:4]), int(months[0][5:7])
    from_date = "%04d-%02d-01T00:00:00Z" % (sy, sm)
    to_date = "%04d-%02d-%02dT00:00:00Z" % (y, m, _last_day(y, m))

    return {"months": months, "labels": labels, "period": "PERIOD_MONTHLY",
            "fromDate": from_date, "toDate": to_date}


def last_n_months(n=48, today=None):
    """Ключи и подписи последних n полных месяцев (для синтетической истории)."""
    today = today or dt.date.today()
    end = today.replace(day=1) - dt.timedelta(days=1)   # последний полный месяц
    y, m = end.year, end.month
    keys = []
    for i in range(n - 1, -1, -1):
        yy, mm = y, m - i
        while mm <= 0:
            mm += 12
            yy -= 1
        keys.append("%04d-%02d" % (yy, mm))
    labels = ["%s %d" % (RU_MONTHS[int(k[5:7])], int(k[:4])) for k in keys]
    return {"keys": keys, "labels": labels}


def period_axis(period="PERIOD_MONTHLY", today=None, n_weeks=13, n_days=30):
    """Ось динамики для выбранного периода (месяц/неделя/день).

    Возвращает ту же структуру, что и last_full_months: ключи (months),
    подписи (labels), period и окно дат. Для недель/дней берём последние
    завершённые периоды (текущий, незавершённый, не включаем).
    """
    period = (period or "PERIOD_MONTHLY").upper()
    if not period.startswith("PERIOD_"):
        period = "PERIOD_" + period
    today = today or dt.date.today()

    if period == "PERIOD_WEEKLY":
        end = today - dt.timedelta(days=today.weekday() + 1)   # последнее воскресенье
        keys, labels = [], []
        for i in range(n_weeks - 1, -1, -1):
            ws = end - dt.timedelta(days=7 * i + 6)            # понедельник недели
            we = end - dt.timedelta(days=7 * i)                # воскресенье недели
            keys.append(ws.isoformat())
            labels.append("%d–%d %s" % (ws.day, we.day, RU_MONTHS[we.month]))
        return {"months": keys, "labels": labels, "period": period,
                "fromDate": keys[0] + "T00:00:00Z",
                "toDate": end.isoformat() + "T00:00:00Z"}

    if period == "PERIOD_DAILY":
        end = today - dt.timedelta(days=1)                     # последний полный день
        keys, labels = [], []
        for i in range(n_days - 1, -1, -1):
            d = end - dt.timedelta(days=i)
            keys.append(d.isoformat())
            labels.append("%d %s" % (d.day, RU_MONTHS[d.month]))
        return {"months": keys, "labels": labels, "period": period,
                "fromDate": keys[0] + "T00:00:00Z",
                "toDate": end.isoformat() + "T00:00:00Z"}

    return last_full_months(today)
