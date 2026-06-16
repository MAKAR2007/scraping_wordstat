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

echo "==> [1/6] Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y python3-venv python3-pip git nginx curl

echo "==> [2/6] Код из GitHub ($APP_DIR)"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  rm -rf "$APP_DIR"
  git clone --depth 1 "$REPO" "$APP_DIR"
fi

echo "==> [3/6] Виртуальное окружение и зависимости"
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"
chown -R www-data:www-data "$APP_DIR"

echo "==> [4/6] systemd-сервис gunicorn (127.0.0.1:$PORT)"
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

echo "==> [5/6] nginx reverse proxy на порт 80"
cat > /etc/nginx/sites-available/wordstat <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/wordstat /etc/nginx/sites-enabled/wordstat
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx

echo "==> [6/6] Firewall (если ufw активен — открываем 80, ssh)"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 22/tcp  || true
  ufw allow 80/tcp  || true
fi

IP=$(hostname -I | awk '{print $1}')
echo
echo "================================================================"
echo "  Готово! Дашборд доступен по адресу:  http://$IP/"
echo "================================================================"
systemctl --no-pager --lines=0 status wordstat | head -4
