# -*- coding: utf-8 -*-
"""
Десктоп-обёртка дашборда: двойной клик → сервер + браузер.

Сборка (см. README):
    .venv/bin/pyinstaller --noconfirm --clean --windowed \
        --name "Аналитика Wordstat" \
        --add-data "static:static" --add-data "data:data" \
        --add-data ".env:." launcher.py

Ключ API ищется в .env: сначала рядом с .app (можно подменить без пересборки),
затем внутри сборки. Без ключа приложение честно работает в демо-режиме.
Окно-диалог (osascript) держит процесс: «Остановить» — сервер гасится.
"""

import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

# В windowed-сборке PyInstaller stdout/stderr могут быть None — Flask/werkzeug
# падают при логировании. Подменяем на devnull.
if getattr(sys, "frozen", False):
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")


def _bundle_dir():
    return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


def _env_candidates():
    """Пути возможных .env: рядом с exe, рядом с .app, внутри сборки."""
    exe = os.path.abspath(sys.executable)
    cands = [os.path.join(os.path.dirname(exe), ".env")]
    if ".app" + os.sep in exe:
        app_root = exe.split(".app" + os.sep)[0] + ".app"
        cands.append(os.path.join(os.path.dirname(app_root), ".env"))
    cands.append(os.path.join(_bundle_dir(), ".env"))
    return cands


def _load_env_file(path):
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
        return True
    except OSError:
        return False


# .env грузим ДО импорта app (первый найденный файл имеет приоритет,
# т.к. уже установленные переменные не перезаписываются).
for _c in _env_candidates():
    _load_env_file(_c)

from app import app as flask_app            # noqa: E402
from yandex_client import WordstatClient    # noqa: E402


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


PORT = int(os.environ.get("PORT") or _free_port())
URL = "http://127.0.0.1:%d" % PORT


def _serve():
    flask_app.run(host="127.0.0.1", port=PORT, debug=False, use_reloader=False)


def _wait_ready(timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            urllib.request.urlopen(URL + "/api/status", timeout=2)
            return True
        except Exception:
            time.sleep(0.25)
    return False


def _dialog(mode_text):
    """Управляющее окно: держит процесс, «Остановить» — выход (и смерть сервера)."""
    if sys.platform == "darwin":
        _dialog_mac(mode_text)
    elif os.name == "nt":
        _dialog_windows(mode_text)
    else:
        while True:
            time.sleep(3600)


def _dialog_mac(mode_text):
    """Нативный диалог macOS через osascript (без зависимостей)."""
    script = (
        'display dialog "Дашборд запущен:\\n%s\\n\\n%s\\n\\n'
        '«Остановить» — завершить работу сервера." '
        'with title "Аналитика Wordstat · ОТП" '
        'buttons {"Открыть в браузере", "Остановить"} '
        'default button "Открыть в браузере" '
        'with icon note giving up after 86400'
    ) % (URL, mode_text)
    while True:
        try:
            res = subprocess.run(["osascript", "-e", script],
                                 capture_output=True, text=True, timeout=86500)
        except Exception:
            time.sleep(3600)
            continue
        out = (res.stdout or "") + (res.stderr or "")
        if "Открыть в браузере" in out:
            webbrowser.open(URL)
            continue
        if "Остановить" in out or res.returncode != 0:
            return        # «Остановить», Esc или закрытие диалога — выходим.
        # gave up:true (сутки прошли) — просто показываем диалог снова.


def _dialog_windows(mode_text):
    """Окно tkinter (в python.org-сборках Windows есть всегда); запасной
    вариант — нативный MessageBox через ctypes."""
    try:
        import tkinter as tk
    except Exception:
        return _dialog_windows_msgbox(mode_text)
    root = tk.Tk()
    root.title("Аналитика Wordstat · ОТП")
    root.geometry("470x220")
    root.resizable(False, False)
    tk.Label(root, text="Дашборд запущен", font=("Segoe UI", 14, "bold")).pack(pady=(16, 2))
    link = tk.Label(root, text=URL, fg="#1a73e8", cursor="hand2", font=("Segoe UI", 11))
    link.pack()
    link.bind("<Button-1>", lambda e: webbrowser.open(URL))
    tk.Label(root, text=mode_text, wraplength=430, font=("Segoe UI", 10)).pack(pady=(4, 10))
    tk.Button(root, text="Открыть в браузере", width=26,
              command=lambda: webbrowser.open(URL)).pack(pady=2)
    tk.Button(root, text="Остановить и выйти", width=26, command=root.destroy).pack(pady=2)
    tk.Label(root, text="Закройте это окно, чтобы остановить сервер.",
             fg="#777", font=("Segoe UI", 9)).pack(pady=(8, 0))
    root.mainloop()


def _dialog_windows_msgbox(mode_text):
    import ctypes
    MB_OKCANCEL, IDOK = 0x00000001, 1
    text = ("Дашборд запущен:\n%s\n\n%s\n\n"
            "OK — открыть в браузере ещё раз.\n"
            "Отмена — остановить сервер и выйти.") % (URL, mode_text)
    while True:
        res = ctypes.windll.user32.MessageBoxW(0, text, "Аналитика Wordstat · ОТП", MB_OKCANCEL)
        if res == IDOK:
            webbrowser.open(URL)
            continue
        return


def main():
    threading.Thread(target=_serve, daemon=True).start()
    ready = _wait_ready()
    demo = WordstatClient().demo_mode
    mode = ("Демо-режим: ключ API не найден (положите .env рядом с приложением)"
            if demo else "Рабочий режим: реальные данные Wordstat API")

    if os.environ.get("WORDSTAT_SMOKE"):
        # Бесголовый самотест для сборки: статус + поиск, без GUI.
        ok = ready
        try:
            req = urllib.request.Request(
                URL + "/api/search", method="POST",
                data=b'{"phrase":"\xd0\xb8\xd0\xbf\xd0\xbe\xd1\x82\xd0\xb5\xd0\xba\xd0\xb0"}',
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:
                import json
                d = json.loads(r.read().decode())
                ok = ok and "dynamics" in d
                print("smoke search source:", d.get("source"),
                      "| months:", len((d.get("dynamics") or {}).get("keys") or []))
        except Exception as exc:
            print("smoke search failed:", exc)
            ok = False
        print("ready:", ready, "| url:", URL, "| demo:", demo)
        sys.exit(0 if ok else 1)

    if ready:
        webbrowser.open(URL)
    _dialog(mode)


if __name__ == "__main__":
    main()
