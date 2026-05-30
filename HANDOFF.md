# Wordstat Dashboard — Handoff

## Стек
- Python 3.14 + Flask 3.x (Node отсутствует)
- openpyxl для Excel
- Chart.js 4.4 (CDN)
- Без внешних HTTP-библиотек — stdlib `urllib`

## Запуск
```
cd C:\Users\mishe\Documents\scraper
python app.py          # http://127.0.0.1:5000
# или двойной клик run.bat
```

## Структура
```
app.py              — Flask-сервер (/api/search, /api/dynamics, /api/export)
yandex_client.py    — клиент Wordstat API + демо-генератор
regions.py          — дерево субъектов РФ, фильтр федеральных округов
months.py           — окно последних 12 полных месяцев
static/
  index.html        — UI (русский)
  styles.css        — OTP-green тема (#52AE30)
  app.js            — Chart.js логика + fetch к API
.env                — YANDEX_API_KEY + YANDEX_FOLDER_ID (рабочий режим)
.env.example        — шаблон
run.bat             — запуск на Windows
requirements.txt    — Flask, openpyxl
.claude/launch.json — конфиг preview-сервера
```

## Ключевые решения

### Регионы
- Данные **строго по субъектам РФ** (84 региона), федеральные округа исключены
- Логика: узел Россия (id=225) → прямые дети = ФО (drop) → их дети = субъекты (keep)
- `regions.py::filter_to_subjects` отсекает ФО, Россию целиком и зарубежные регионы

### Период динамики
- Всегда **последние 12 полных месяцев** — `months.py::last_full_months()`
- «Полный» = завершённый; текущий месяц не входит
- Пример на 29.05.2026: май 2025 → апрель 2026

### Динамика по регионам
- Эндпоинт `POST /api/dynamics` принимает `{phrase, region, devices}`
- `region="ALL"` — агрегат по всем субъектам; иначе один субъект
- Селектор в UI обновляет график без перезагрузки страницы

### Excel (`/api/export`)
- Лист «Регионы РФ»: первая строка = шапка (без заголовочных строк, без №)
- Колонки: Регион | Показов | Доля % | Индекс | + 12 месячных колонок
- Месячные данные — `WordstatClient.monthly_matrix()` (1 запрос на регион)
- Лист «Динамика»: месяц + показов
- ⚠️ В рабочем режиме экспорт ≈84 запроса → 20–30 сек

### Аутентификация
- `.env` загружается встроенным парсером в `app.py::_load_dotenv()` (без python-dotenv)
- `YANDEX_API_KEY` → `Authorization: Api-Key ...`
- `YANDEX_IAM_TOKEN` → `Authorization: Bearer ...`
- Без `.env` — демо-режим (синтетические данные)

## API эндпоинты Yandex
```
Base: https://searchapi.api.cloud.yandex.net/v2/wordstat
POST /regions          — распределение по регионам
POST /dynamics         — динамика во времени
POST /topRequests      — топ запросов (не используется после удаления раздела)
POST /getRegionsTree   — дерево регионов
```

## Что было удалено
- Раздел «Связанные запросы» (таблица + лист Excel + вызов getTop) — удалён полностью

## Зависимости для новой машины
```
pip install flask openpyxl
```
Chart.js грузится с CDN — нужен интернет при первом открытии.
Для полностью офлайн-режима скачать `chart.umd.min.js` в `static/` и поправить путь в `index.html`.

## Credentials (рабочий режим)
Файл `.env` в корне проекта (не коммитить в git):
```
YANDEX_API_KEY=...
YANDEX_FOLDER_ID=...
```
