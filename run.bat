@echo off
REM Запуск дашборда Wordstat. Сервер: http://127.0.0.1:5000
cd /d "%~dp0"
python -m pip install -r requirements.txt --quiet --disable-pip-version-check
python app.py
pause
