#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1
python3 - <<'PY'
import http.server
import webbrowser

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), http.server.SimpleHTTPRequestHandler)
url = f'http://127.0.0.1:{server.server_port}/'
print('\nсумка-пылесос · 1.0\n' + url + '\nОставь это окно открытым во время игры.\n')
webbrowser.open(url)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
PY
