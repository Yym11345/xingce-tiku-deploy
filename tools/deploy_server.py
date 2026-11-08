# -*- coding: utf-8 -*-
"""线上版服务：静态文件 + gzip + 账号系统（用户名/密码）

- 静态：JSON/JS/CSS 走内存缓存 gzip
- 账号：SQLite（.data/app.db），PBKDF2 密码哈希，HttpOnly 会话 Cookie
- 同步：每个账号一份学习记录（错题/收藏/作答日志）
监听环境变量 PORT，绑定 0.0.0.0。仅用标准库。
"""
import os
import io
import gzip
import json
import time
import hmac
import sqlite3
import hashlib
import secrets
import threading
import re
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_DIR = os.path.join(ROOT, '.data')
DB_PATH = os.path.join(DB_DIR, 'app.db')

GZ_EXT = ('.json', '.js', '.css', '.html', '.svg', '.md')
GZ_MAX = 80 * 1024 * 1024
COOKIE = 'xc_sid'
SESSION_DAYS = 30
PBKDF2_ROUNDS = 120000
MAX_BODY = 4 * 1024 * 1024          # 单次同步上限 4MB
SYNC_KEYS = ('wrong', 'star', 'log')

_cache, _cache_size, _lock = {}, [0], threading.Lock()
_db_lock = threading.Lock()

USER_RE = re.compile(r'^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$')
PW_MIN, PW_MAX = 6, 64


# ---------------- 数据库 ----------------
def db():
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.execute('PRAGMA journal_mode=WAL')
    return conn


def init_db():
    with _db_lock, db() as c:
        c.executescript('''
        CREATE TABLE IF NOT EXISTS users(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            uname_lc TEXT UNIQUE NOT NULL,
            pwd TEXT NOT NULL,
            created INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions(
            token TEXT PRIMARY KEY,
            uid INTEGER NOT NULL,
            created INTEGER NOT NULL,
            last INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync(
            uid INTEGER NOT NULL,
            k TEXT NOT NULL,
            v TEXT NOT NULL,
            updated INTEGER NOT NULL,
            PRIMARY KEY(uid, k)
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_uid ON sessions(uid);
        ''')


def hash_pwd(pw):
    salt = secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac('sha256', pw.encode('utf-8'), salt, PBKDF2_ROUNDS)
    return 'pbkdf2$%d$%s$%s' % (PBKDF2_ROUNDS, salt.hex(), h.hex())


def check_pwd(pw, stored):
    try:
        algo, rounds, salt_hex, hash_hex = stored.split('$')
        if algo != 'pbkdf2':
            return False
        h = hashlib.pbkdf2_hmac('sha256', pw.encode('utf-8'),
                                bytes.fromhex(salt_hex), int(rounds))
        return hmac.compare_digest(h.hex(), hash_hex)
    except Exception:
        return False


# ---------------- 限流 ----------------
_attempts = {}
_att_lock = threading.Lock()


def too_many(key):
    now = time.time()
    with _att_lock:
        arr = [t for t in _attempts.get(key, []) if now - t < 600]
        _attempts[key] = arr
        return len(arr) >= 12


def note_fail(key):
    with _att_lock:
        _attempts.setdefault(key, []).append(time.time())


def clear_fail(key):
    with _att_lock:
        _attempts.pop(key, None)


# ---------------- HTTP ----------------
class Handler(SimpleHTTPRequestHandler):
    server_version = 'xingce/1.1'
    protocol_version = 'HTTP/1.1'

    # ---- 工具 ----
    def _json(self, obj, code=200, cookie=None):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _body(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            return None
        if n <= 0 or n > MAX_BODY:
            return None
        try:
            return json.loads(self.rfile.read(n).decode('utf-8'))
        except Exception:
            return None

    def _is_https(self):
        return (self.headers.get('X-Forwarded-Proto', '') or '').lower() == 'https'

    def _cookie(self, token, days=SESSION_DAYS):
        parts = ['%s=%s' % (COOKIE, token), 'Path=/', 'HttpOnly',
                 'SameSite=Lax', 'Max-Age=%d' % (days * 86400)]
        if self._is_https():
            parts.append('Secure')
        return '; '.join(parts)

    def _sid(self):
        raw = self.headers.get('Cookie', '')
        for part in raw.split(';'):
            k, _, v = part.strip().partition('=')
            if k == COOKIE:
                return v
        return None

    def _user(self):
        tok = self._sid()
        if not tok:
            return None
        with _db_lock, db() as c:
            row = c.execute(
                'SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.uid '
                'WHERE s.token=? AND s.last>?', (tok, int(time.time()) - SESSION_DAYS * 86400)
            ).fetchone()
            if row:
                c.execute('UPDATE sessions SET last=? WHERE token=?', (int(time.time()), tok))
                return {'id': row[0], 'name': row[1]}
        return None

    def _client(self):
        return (self.headers.get('X-Forwarded-For', '').split(',')[0].strip()
                or self.client_address[0])

    # ---- 路由 ----
    def do_GET(self):
        if self.path.startswith('/api/'):
            return self.api_get()
        return self.static()

    def do_POST(self):
        if self.path.startswith('/api/'):
            return self.api_post()
        self._body()          # 读完请求体，避免污染 keep-alive 连接
        self.send_error(404)

    def api_get(self):
        p = self.path.split('?')[0]
        if p == '/api/auth/me':
            u = self._user()
            return self._json({'user': u})
        if p == '/api/sync':
            u = self._user()
            if not u:
                return self._json({'error': '未登录'}, 401)
            with _db_lock, db() as c:
                rows = c.execute('SELECT k,v FROM sync WHERE uid=?', (u['id'],)).fetchall()
            data = {}
            for k, v in rows:
                try:
                    data[k] = json.loads(v)
                except Exception:
                    pass
            return self._json({'data': data})
        return self._json({'error': 'not found'}, 404)

    def api_post(self):
        p = self.path.split('?')[0]
        # 必须先把请求体读完，否则 keep-alive 下残留字节会污染下一个请求
        body = self._body()
        if p == '/api/auth/register':
            return self.reg(body)
        if p == '/api/auth/login':
            return self.login(body)
        if p == '/api/auth/password':
            return self.change_pwd(body)
        if p == '/api/auth/logout':
            tok = self._sid()
            if tok:
                with _db_lock, db() as c:
                    c.execute('DELETE FROM sessions WHERE token=?', (tok,))
            return self._json({'ok': True}, cookie='%s=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' % COOKIE)
        if p == '/api/sync':
            return self.sync(body)
        return self._json({'error': 'not found'}, 404)

    def _issue(self, uid, name):
        tok = secrets.token_urlsafe(32)
        now = int(time.time())
        with _db_lock, db() as c:
            c.execute('INSERT INTO sessions(token,uid,created,last) VALUES(?,?,?,?)',
                      (tok, uid, now, now))
            c.execute('DELETE FROM sessions WHERE last<?', (now - SESSION_DAYS * 86400,))
        return self._json({'user': {'name': name}}, cookie=self._cookie(tok))

    def reg(self, d=None):
        d = d or {}
        name = str(d.get('username', '')).strip()
        pw = str(d.get('password', ''))
        if not USER_RE.match(name):
            return self._json({'error': '用户名需 2–20 位，只能用中文、字母、数字或下划线'}, 400)
        if not (PW_MIN <= len(pw) <= PW_MAX):
            return self._json({'error': '密码长度需 6–64 位'}, 400)
        lc = name.lower()
        with _db_lock, db() as c:
            if c.execute('SELECT 1 FROM users WHERE uname_lc=?', (lc,)).fetchone():
                return self._json({'error': '该用户名已被注册'}, 409)
            c.execute('INSERT INTO users(username,uname_lc,pwd,created) VALUES(?,?,?,?)',
                      (name, lc, hash_pwd(pw), int(time.time())))
            uid = c.execute('SELECT id FROM users WHERE uname_lc=?', (lc,)).fetchone()[0]
        return self._issue(uid, name)

    def login(self, d=None):
        d = d or {}
        name = str(d.get('username', '')).strip()
        pw = str(d.get('password', ''))
        key = self._client() + '|' + name.lower()
        if too_many(key):
            return self._json({'error': '尝试次数过多，请 10 分钟后再试'}, 429)
        with _db_lock, db() as c:
            row = c.execute('SELECT id,username,pwd FROM users WHERE uname_lc=?',
                            (name.lower(),)).fetchone()
        if not row or not check_pwd(pw, row[2]):
            note_fail(key)
            return self._json({'error': '用户名或密码不正确'}, 401)
        clear_fail(key)
        return self._issue(row[0], row[1])

    def change_pwd(self, d=None):
        u = self._user()
        if not u:
            return self._json({'error': '请先登录'}, 401)
        d = d or {}
        old = str(d.get('old', ''))
        new = str(d.get('new', ''))
        if not (PW_MIN <= len(new) <= PW_MAX):
            return self._json({'error': '新密码长度需 6–64 位'}, 400)
        if old == new:
            return self._json({'error': '新密码不能与原密码相同'}, 400)
        with _db_lock, db() as c:
            row = c.execute('SELECT pwd FROM users WHERE id=?', (u['id'],)).fetchone()
            if not row or not check_pwd(old, row[0]):
                return self._json({'error': '原密码不正确'}, 401)
            c.execute('UPDATE users SET pwd=? WHERE id=?', (hash_pwd(new), u['id']))
            # 其他设备下线，保留当前会话
            c.execute('DELETE FROM sessions WHERE uid=? AND token<>?', (u['id'], self._sid()))
        return self._json({'ok': True})

    def sync(self, d=None):
        u = self._user()
        if not u:
            return self._json({'error': '未登录'}, 401)
        if not isinstance(d, dict) or not isinstance(d.get('data'), dict):
            return self._json({'error': '数据格式不正确'}, 400)
        now = int(time.time())
        with _db_lock, db() as c:
            for k in SYNC_KEYS:
                if k in d['data']:
                    c.execute('INSERT INTO sync(uid,k,v,updated) VALUES(?,?,?,?) '
                              'ON CONFLICT(uid,k) DO UPDATE SET v=excluded.v, updated=excluded.updated',
                              (u['id'], k, json.dumps(d['data'][k], ensure_ascii=False), now))
        return self._json({'ok': True, 'at': now})

    # ---- 静态 ----
    def static(self):
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().do_GET()
        try:
            st = os.stat(path)
        except OSError:
            return super().do_GET()

        ext = os.path.splitext(path)[1].lower()
        use_gz = ext in GZ_EXT and 'gzip' in self.headers.get('Accept-Encoding', '')
        try:
            body = gz_bytes(path, st) if use_gz else open(path, 'rb').read()
        except OSError:
            self.send_error(404, 'Not Found')
            return

        self.send_response(200)
        self.send_header('Content-Type', self.guess_type(path))
        if use_gz:
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Vary', 'Accept-Encoding')
        self.send_header('Content-Length', str(len(body)))
        if ext in ('.png', '.webp', '.jpg', '.jpeg', '.gif', '.svg', '.ico'):
            self.send_header('Cache-Control', 'public, max-age=604800, immutable')
        elif ext == '.json':
            self.send_header('Cache-Control', 'public, max-age=3600')
        else:
            self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def guess_type(self, path):
        if path.endswith('.json'):
            return 'application/json; charset=utf-8'
        if path.endswith('.js'):
            return 'text/javascript; charset=utf-8'
        if path.endswith('.css'):
            return 'text/css; charset=utf-8'
        if path.endswith('.html'):
            return 'text/html; charset=utf-8'
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        pass


def gz_bytes(path, st):
    key = (path, st.st_mtime_ns, st.st_size)
    with _lock:
        hit = _cache.get(key)
    if hit is not None:
        return hit
    with open(path, 'rb') as f:
        raw = f.read()
    if len(raw) > 8 * 1024 * 1024:
        return gzip.compress(raw, 6)
    out = gzip.compress(raw, 6)
    with _lock:
        if _cache_size[0] + len(out) < GZ_MAX:
            _cache[key] = out
            _cache_size[0] += len(out)
    return out


def main():
    init_db()
    port = int(os.environ.get('PORT', '8765'))
    httpd = ThreadingHTTPServer(('0.0.0.0', port), partial(Handler, directory=ROOT))
    httpd.daemon_threads = True
    print(f'listening on 0.0.0.0:{port}  root={ROOT}', flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
