# Шаблон WSGI-файла для PythonAnywhere (бесплатный хостинг, открыт в РФ без VPN).
#
# Как использовать:
#   1. На PythonAnywhere во вкладке Web → раздел «Code» → откройте ссылку на
#      «WSGI configuration file» (обычно /var/www/<логин>_pythonanywhere_com_wsgi.py).
#   2. Удалите всё содержимое того файла и вставьте код ниже,
#      заменив <ЛОГИН> на ваш логин PythonAnywhere.
#   3. Нажмите Save, затем Reload во вкладке Web.

import sys

PROJECT_DIR = "/home/<ЛОГИН>/scraping_wordstat"
if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)

# Flask-приложение без ключа API работает в демо-режиме:
# реальные данные по продуктам из CSV, остальное — прикидочные.
from app import app as application  # noqa: E402
