#!/usr/bin/env bash
#
# Включение HTTPS (бесплатный сертификат Let's Encrypt) для дашборда.
# Запускать от root НА СЕРВЕРЕ, ПОСЛЕ того как A-запись домена указывает на
# этот VPS (проверка домена идёт по HTTP на порт 80):
#
#   DOMAIN=stat.example.ru EMAIL=you@example.ru bash enable-https.sh
#
# Что делает: ставит certbot, прописывает домен в nginx, получает и
# устанавливает сертификат, включает редирект http→https и автопродление,
# открывает 443 в ufw. Идемпотентно: повторный запуск обновит конфиг.

set -euo pipefail

: "${DOMAIN:?Укажите домен: DOMAIN=ваш-домен.ру bash enable-https.sh}"
EMAIL="${EMAIL:-}"
NGINX_SITE=/etc/nginx/sites-available/wordstat

if [ ! -f "$NGINX_SITE" ]; then
  echo "Не найден $NGINX_SITE — сначала разверните приложение (deploy/setup.sh)." >&2
  exit 1
fi

echo "==> [1/4] certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y certbot python3-certbot-nginx

echo "==> [2/4] Домен $DOMAIN в server_name nginx"
# Меняем server_name _ (или предыдущий домен) на нужный — иначе certbot --nginx
# не найдёт подходящий server-блок.
sed -i -E "s/server_name .*/server_name ${DOMAIN};/" "$NGINX_SITE"
nginx -t
systemctl reload nginx

echo "==> [3/4] Сертификат Let's Encrypt + редирект на HTTPS"
ARGS=(--nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos)
if [ -n "$EMAIL" ]; then
  ARGS+=(-m "$EMAIL")
else
  ARGS+=(--register-unsafely-without-email)
fi
certbot "${ARGS[@]}"

echo "==> [4/4] Firewall: открываем 443"
if command -v ufw >/dev/null; then
  ufw allow 443/tcp >/dev/null 2>&1 || true
fi
systemctl reload nginx

echo
echo "================================================================"
echo "  Готово! HTTPS включён:  https://$DOMAIN/"
echo "  Автопродление сертификата — таймером certbot.timer (systemd)."
echo "================================================================"
