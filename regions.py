# -*- coding: utf-8 -*-
"""
Классификация регионов Российской Федерации для Yandex Wordstat.

Ключевое требование проекта: данные строго разбиваются по самостоятельным
регионам (субъектам) РФ. Федеральные округа полностью исключаются — они
являются агрегирующими узлами дерева Wordstat и не должны попадать ни в
графики, ни в выгрузку Excel.

Структура дерева Yandex Wordstat для России:
    Россия (225)
      └── Федеральный округ        <- ИСКЛЮЧАЕТСЯ (агрегат)
            └── Субъект РФ          <- ОСТАВЛЯЕМ (область / край / республика / город ФЗ / АО)
                  └── Город          <- не используется на уровне регионов

Логика классификации (build_subject_index) опирается на саму структуру
дерева: прямые потомки России — это федеральные округа (исключаем), их
потомки — это субъекты РФ (оставляем). Поэтому фильтрация корректна даже
при изменении конкретных идентификаторов в API.

Встроенное дерево RUSSIA_TREE используется как:
  * источник данных в демо-режиме (когда ключ API не задан);
  * резервный справочник, если живой вызов getRegionsTree недоступен.
"""

RUSSIA_ID = "225"

# Федеральные округа -> субъекты РФ.
# id здесь — официальные идентификаторы регионов Yandex там, где они известны.
# Состав по 8 федеральным округам (без учёта федеральных округов как строк данных).
RUSSIA_TREE = {
    "id": RUSSIA_ID,
    "label": "Россия",
    "children": [
        {
            "id": "3",
            "label": "Центральный федеральный округ",
            "children": [
                {"id": "213", "label": "Москва"},
                {"id": "1", "label": "Московская область"},
                {"id": "4", "label": "Белгородская область"},
                {"id": "191", "label": "Брянская область"},
                {"id": "192", "label": "Владимирская область"},
                {"id": "193", "label": "Воронежская область"},
                {"id": "5", "label": "Ивановская область"},
                {"id": "6", "label": "Калужская область"},
                {"id": "7", "label": "Костромская область"},
                {"id": "8", "label": "Курская область"},
                {"id": "9", "label": "Липецкая область"},
                {"id": "10", "label": "Орловская область"},
                {"id": "11", "label": "Рязанская область"},
                {"id": "12", "label": "Смоленская область"},
                {"id": "13", "label": "Тамбовская область"},
                {"id": "14", "label": "Тверская область"},
                {"id": "15", "label": "Тульская область"},
                {"id": "16", "label": "Ярославская область"},
            ],
        },
        {
            "id": "17",
            "label": "Северо-Западный федеральный округ",
            "children": [
                {"id": "2", "label": "Санкт-Петербург"},
                {"id": "10174", "label": "Ленинградская область"},
                {"id": "10897", "label": "Республика Карелия"},
                {"id": "11", "label": "Республика Коми"},
                {"id": "20", "label": "Архангельская область"},
                {"id": "21", "label": "Вологодская область"},
                {"id": "22", "label": "Калининградская область"},
                {"id": "23", "label": "Мурманская область"},
                {"id": "24", "label": "Новгородская область"},
                {"id": "25", "label": "Псковская область"},
                {"id": "10841", "label": "Ненецкий автономный округ"},
            ],
        },
        {
            "id": "26",
            "label": "Южный федеральный округ",
            "children": [
                {"id": "35", "label": "Краснодарский край"},
                {"id": "39", "label": "Ростовская область"},
                {"id": "37", "label": "Астраханская область"},
                {"id": "38", "label": "Волгоградская область"},
                {"id": "10995", "label": "Республика Адыгея"},
                {"id": "11070", "label": "Республика Калмыкия"},
                {"id": "977", "label": "Республика Крым"},
                {"id": "959", "label": "Севастополь"},
            ],
        },
        {
            "id": "40",
            "label": "Северо-Кавказский федеральный округ",
            "children": [
                {"id": "1106", "label": "Республика Дагестан"},
                {"id": "11051", "label": "Республика Ингушетия"},
                {"id": "11061", "label": "Кабардино-Балкарская Республика"},
                {"id": "11013", "label": "Карачаево-Черкесская Республика"},
                {"id": "11021", "label": "Республика Северная Осетия — Алания"},
                {"id": "11024", "label": "Чеченская Республика"},
                {"id": "36", "label": "Ставропольский край"},
            ],
        },
        {
            "id": "40000",
            "label": "Приволжский федеральный округ",
            "children": [
                {"id": "11119", "label": "Республика Башкортостан"},
                {"id": "11146", "label": "Республика Марий Эл"},
                {"id": "11153", "label": "Республика Мордовия"},
                {"id": "11119000", "label": "Республика Татарстан"},
                {"id": "11176", "label": "Удмуртская Республика"},
                {"id": "11181", "label": "Чувашская Республика"},
                {"id": "11108", "label": "Пермский край"},
                {"id": "46", "label": "Кировская область"},
                {"id": "47", "label": "Нижегородская область"},
                {"id": "48", "label": "Оренбургская область"},
                {"id": "49", "label": "Пензенская область"},
                {"id": "51", "label": "Самарская область"},
                {"id": "194", "label": "Саратовская область"},
                {"id": "195", "label": "Ульяновская область"},
            ],
        },
        {
            "id": "52",
            "label": "Уральский федеральный округ",
            "children": [
                {"id": "53", "label": "Курганская область"},
                {"id": "54", "label": "Свердловская область"},
                {"id": "55", "label": "Тюменская область"},
                {"id": "56", "label": "Челябинская область"},
                {"id": "11193", "label": "Ханты-Мансийский автономный округ — Югра"},
                {"id": "11457", "label": "Ямало-Ненецкий автономный округ"},
            ],
        },
        {
            "id": "59",
            "label": "Сибирский федеральный округ",
            "children": [
                {"id": "11235", "label": "Республика Алтай"},
                {"id": "11247", "label": "Республика Тыва"},
                {"id": "11340", "label": "Республика Хакасия"},
                {"id": "11235000", "label": "Алтайский край"},
                {"id": "62", "label": "Красноярский край"},
                {"id": "63", "label": "Иркутская область"},
                {"id": "64", "label": "Кемеровская область"},
                {"id": "65", "label": "Новосибирская область"},
                {"id": "66", "label": "Омская область"},
                {"id": "67", "label": "Томская область"},
            ],
        },
        {
            "id": "73",
            "label": "Дальневосточный федеральный округ",
            "children": [
                {"id": "11309", "label": "Республика Бурятия"},
                {"id": "11458", "label": "Республика Саха (Якутия)"},
                {"id": "11457000", "label": "Забайкальский край"},
                {"id": "11398", "label": "Камчатский край"},
                {"id": "75", "label": "Приморский край"},
                {"id": "76", "label": "Хабаровский край"},
                {"id": "77", "label": "Амурская область"},
                {"id": "78", "label": "Магаданская область"},
                {"id": "79", "label": "Сахалинская область"},
                {"id": "11451", "label": "Еврейская автономная область"},
                {"id": "11479", "label": "Чукотский автономный округ"},
            ],
        },
    ],
}


def _walk_subjects_from_tree(russia_node):
    """Возвращает (subject_id -> name, fd_id -> name) из узла «Россия».

    Прямые потомки России трактуются как федеральные округа (исключаются),
    их потомки — как субъекты РФ (оставляются).
    """
    subjects = {}
    federal_districts = {}
    for fd in russia_node.get("children", []) or []:
        fd_id = str(fd.get("id"))
        federal_districts[fd_id] = fd.get("label") or fd.get("name") or fd_id
        for subj in fd.get("children", []) or []:
            sid = str(subj.get("id"))
            subjects[sid] = subj.get("label") or subj.get("name") or sid
    return subjects, federal_districts


def _find_russia(nodes):
    """Ищет узел России (id == 225) в списке узлов верхнего уровня."""
    for node in nodes or []:
        if str(node.get("id")) == RUSSIA_ID:
            return node
        found = _find_russia(node.get("children"))
        if found:
            return found
    return None


def build_subject_index(regions_tree=None):
    """Строит индекс субъектов РФ.

    :param regions_tree: ответ getRegionsTree вида {"regions": [...]} либо None.
                         При None используется встроенное дерево RUSSIA_TREE.
    :return: dict(
                subjects={id: name},          # субъекты РФ — оставляем
                federal_districts={id: name}, # федеральные округа — исключаем
                russia_id="225",
             )
    """
    russia = None
    if regions_tree:
        nodes = regions_tree.get("regions") or regions_tree.get("children") or []
        russia = _find_russia(nodes)
    if russia is None:
        russia = RUSSIA_TREE

    subjects, federal_districts = _walk_subjects_from_tree(russia)
    return {
        "subjects": subjects,
        "federal_districts": federal_districts,
        "russia_id": RUSSIA_ID,
    }


def filter_to_subjects(distribution_results, subject_index):
    """Фильтрует ответ getRegionsDistribution, оставляя только субъекты РФ.

    Исключаются: федеральные округа, сама Россия и любые регионы вне списка
    субъектов РФ (например, зарубежные страны).

    :param distribution_results: список вида [{"region": id, "count": ..,
                                  "share": .., "affinityIndex": ..}, ...]
    :param subject_index: результат build_subject_index().
    :return: список вида [{"id", "name", "count", "share", "affinityIndex"}],
             отсортированный по убыванию count.
    """
    subjects = subject_index["subjects"]
    rows = []
    for item in distribution_results or []:
        rid = str(item.get("region"))
        if rid not in subjects:
            # Пропускаем федеральные округа, Россию и зарубежные регионы.
            continue
        rows.append(
            {
                "id": rid,
                "name": subjects[rid],
                "count": _to_int(item.get("count")),
                "share": _to_float(item.get("share")),
                "affinityIndex": _to_float(item.get("affinityIndex")),
            }
        )
    rows.sort(key=lambda r: r["count"], reverse=True)
    return rows


def all_subject_ids(subject_index):
    """Список id всех субъектов РФ (для передачи в regions[] других методов)."""
    return list(subject_index["subjects"].keys())


def _to_int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0
