#!/usr/bin/env bash
#
# Установка дашборда «Аналитика Wordstat» на свой VPS (Ubuntu 22.04/24.04).
# Запускать от root:
#     curl -fsSL https://raw.githubusercontent.com/MAKAR2007/scraping_wordstat/main/deploy/setup.sh | bash
#
# Что делает: ставит Python/nginx, клонирует репозиторий, поднимает gunicorn
# как systemd-сервис и проксирует его через nginx на порт 80.
# Демо-режим (без ключа API): реальные данные по продуктам из CSV, остальное —
# прикидочные. Идемпотентно: повторный запуск = обновление до свежего кода.

set -euo pipefail

APP_DIR=/opt/wordstat
REPO=https://github.com/MAKAR2007/scraping_wordstat.git
PORT=8000

echo "==> [1/7] Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y python3-venv python3-pip git nginx curl

echo "==> [2/7] Код из GitHub ($APP_DIR)"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  rm -rf "$APP_DIR"
  git clone --depth 1 "$REPO" "$APP_DIR"
fi

echo "==> [3/7] Виртуальное окружение и зависимости"
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"

echo "==> [4/7] Файл .env (рабочий режим / защита входа, если переданы)"
# .env в gitignore и не затирается `git reset --hard`, поэтому однажды
# созданный — переживает повторные запуски. Если уже есть — не трогаем.
# Переменные при запуске установщика:
#   YANDEX_API_KEY=... YANDEX_FOLDER_ID=...   — рабочий режим (живой API)
#   APP_PASSWORD=... [APP_USER=...]           — закрыть сайт логином/паролем
if [ -f "$APP_DIR/.env" ]; then
  echo "    .env уже существует — оставляю как есть"
elif [ -n "${YANDEX_API_KEY:-}${YANDEX_IAM_TOKEN:-}${APP_PASSWORD:-}" ]; then
  {
    [ -n "${YANDEX_API_KEY:-}" ]   && echo "YANDEX_API_KEY=${YANDEX_API_KEY}"
    [ -n "${YANDEX_IAM_TOKEN:-}" ] && echo "YANDEX_IAM_TOKEN=${YANDEX_IAM_TOKEN}"
    [ -n "${YANDEX_FOLDER_ID:-}" ] && echo "YANDEX_FOLDER_ID=${YANDEX_FOLDER_ID}"
    [ -n "${APP_USER:-}" ]         && echo "APP_USER=${APP_USER}"
    [ -n "${APP_PASSWORD:-}" ]     && echo "APP_PASSWORD=${APP_PASSWORD}"
  } > "$APP_DIR/.env"
  echo "    .env создан"
else
  echo "    креды не переданы — демо-режим (реальные данные продуктов из CSV)"
fi

chown -R www-data:www-data "$APP_DIR"
[ -f "$APP_DIR/.env" ] && chmod 600 "$APP_DIR/.env"

echo "==> [5/7] systemd-сервис gunicorn (127.0.0.1:$PORT)"
cat > /etc/systemd/system/wordstat.service <<UNIT
[Unit]
Description=Wordstat OTP dashboard
After=network.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/.venv/bin/gunicorn app:app --bind 127.0.0.1:$PORT --workers 2 --timeout 90
Restart=always
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable wordstat
systemctl restart wordstat

echo "==> [6/7] nginx reverse proxy на порт 80"
cat > /etc/nginx/sites-available/wordstat <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # gzip для текстовых ответов (HTML/CSS/JS/JSON) — меньше трафика из РФ.
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;

    # Excel-выгрузка может занимать десятки секунд (≈84 запроса к API).
    client_max_body_size 4m;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 10s;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/wordstat /etc/nginx/sites-enabled/wordstat
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx

echo "==> [7/7] Firewall (ufw): пускаем SSH + HTTP, затем включаем"
# Порядок важен: сначала разрешаем 22, потом включаем — иначе можно
# отрезать себе SSH. --force, чтобы не было интерактивного вопроса.
if command -v ufw >/dev/null; then
  ufw allow 22/tcp  >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
fi

# Реальный внешний IP — это src-адрес дефолтного маршрута, а не первый из
# `hostname -I` (там первым может оказаться docker0 / внутренний интерфейс).
IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
[ -z "$IP" ] && IP=$(hostname -I | awk '{print $1}')
echo
echo "================================================================"
echo "  Готово! Дашборд доступен по адресу:  http://$IP/"
echo "================================================================"
systemctl --no-pager --lines=0 status wordstat | head -4
