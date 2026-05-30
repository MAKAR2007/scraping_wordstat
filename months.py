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

    return {"months": months, "labels": labels,
            "fromDate": from_date, "toDate": to_date}
