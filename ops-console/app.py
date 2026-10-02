import hmac
import os
import secrets
import time
from functools import wraps

import psycopg
from psycopg.rows import dict_row
from flask import Flask, jsonify, render_template, request, session

app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.environ.get('SECRET_KEY', ''),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=os.environ.get('SESSION_COOKIE_SECURE', 'true').lower() == 'true',
    MAX_CONTENT_LENGTH=16 * 1024,
    PERMANENT_SESSION_LIFETIME=3600,
)
APP_PASSWORD = os.environ.get('APP_PASSWORD', '')
if len(app.config['SECRET_KEY']) < 32 or len(APP_PASSWORD) < 16:
    raise RuntimeError('SECRET_KEY and APP_PASSWORD are required; minimum lengths are 32 and 16 characters.')


@app.after_request
def security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'same-origin'
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    if request.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
    return response


def connect():
    return psycopg.connect(
        host=os.environ.get('DB_HOST', 'db'),
        port=int(os.environ.get('DB_PORT', '5432')),
        dbname=os.environ.get('DB_NAME', 'opsconsole'),
        user=os.environ.get('DB_USER', 'opsconsole'),
        password=os.environ['DB_PASSWORD'],
        connect_timeout=3,
        row_factory=dict_row,
    )


def init_db():
    with connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS incidents (
                id BIGSERIAL PRIMARY KEY,
                title VARCHAR(120) NOT NULL,
                service VARCHAR(80) NOT NULL,
                severity VARCHAR(12) NOT NULL CHECK (severity IN ('low','medium','high','critical')),
                status VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
                details VARCHAR(1200) NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS activity (
                id BIGSERIAL PRIMARY KEY,
                incident_id BIGINT REFERENCES incidents(id) ON DELETE SET NULL,
                action VARCHAR(30) NOT NULL,
                note VARCHAR(300) NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)


def require_login(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        if not session.get('authenticated'):
            if request.path.startswith('/api/'):
                return jsonify(error='Sesi berakhir. Silakan masuk kembali.'), 401
            return render_template('index.html')
        return fn(*args, **kwargs)
    return wrapped


def require_csrf():
    if not hmac.compare_digest(str(request.headers.get('X-CSRF-Token', '')),
                               str(session.get('csrf_token', ''))):
        return jsonify(error='Token keamanan berakhir. Muat ulang halaman.'), 403
    return None


@app.get('/health')
def health():
    return jsonify(status='alive'), 200


@app.get('/ready')
def ready():
    try:
        with connect() as conn:
            conn.execute('SELECT 1')
        return jsonify(status='ready', database='connected'), 200
    except Exception:
        return jsonify(status='not_ready', database='unavailable'), 503


@app.get('/')
def home():
    return render_template('index.html')


@app.get('/api/session')
def get_session():
    return jsonify(authenticated=bool(session.get('authenticated')),
                   csrfToken=session.get('csrf_token') if session.get('authenticated') else None)


@app.post('/api/login')
def login():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify(error='Format permintaan tidak valid.'), 400
    password = data.get('password', '')
    if not isinstance(password, str) or len(password) > 256 or not hmac.compare_digest(password, APP_PASSWORD):
        time.sleep(0.4)
        return jsonify(error='Password tidak cocok.'), 401
    session.clear()
    session.permanent = True
    session['authenticated'] = True
    session['csrf_token'] = secrets.token_urlsafe(32)
    return jsonify(authenticated=True, csrfToken=session['csrf_token'])


@app.post('/api/logout')
@require_login
def logout():
    error = require_csrf()
    if error:
        return error
    session.clear()
    return jsonify(ok=True)


@app.get('/api/summary')
@require_login
def summary():
    try:
        with connect() as conn:
            row = conn.execute("""
                SELECT count(*) FILTER (WHERE status='open') AS open,
                       count(*) FILTER (WHERE status='resolved') AS resolved,
                       count(*) FILTER (WHERE severity IN ('high','critical') AND status='open') AS urgent,
                       count(*) FILTER (WHERE created_at >= date_trunc('day', now())) AS today
                FROM incidents
            """).fetchone()
            row['db'] = 'connected'
        return jsonify(row)
    except Exception:
        return jsonify(error='Database tidak bisa dibaca.'), 503


@app.get('/api/incidents')
@require_login
def incidents():
    status = request.args.get('status', 'all')
    if status not in ('all', 'open', 'resolved'):
        return jsonify(error='Filter status tidak valid.'), 400
    try:
        with connect() as conn:
            rows = conn.execute("""
                SELECT id,title,service,severity,status,details,created_at,updated_at
                FROM incidents
                WHERE (%s = 'all' OR status = %s)
                ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
                         CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                         created_at DESC
                LIMIT 100
            """, (status, status)).fetchall()
        return jsonify(incidents=rows)
    except Exception:
        return jsonify(error='Daftar insiden tidak bisa dibaca.'), 503


@app.post('/api/incidents')
@require_login
def create_incident():
    error = require_csrf()
    if error:
        return error
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify(error='Format permintaan tidak valid.'), 400
    title = data.get('title', '').strip() if isinstance(data.get('title'), str) else ''
    service = data.get('service', '').strip() if isinstance(data.get('service'), str) else ''
    details = data.get('details', '').strip() if isinstance(data.get('details'), str) else ''
    severity = data.get('severity')
    if not 3 <= len(title) <= 120 or not 2 <= len(service) <= 80 or len(details) > 1200:
        return jsonify(error='Judul (3–120) dan layanan (2–80) wajib diisi; detail maksimal 1200 karakter.'), 400
    if severity not in ('low', 'medium', 'high', 'critical'):
        return jsonify(error='Pilih tingkat dampak yang tersedia.'), 400
    try:
        with connect() as conn:
            row = conn.execute("""
                INSERT INTO incidents (title,service,severity,details)
                VALUES (%s,%s,%s,%s) RETURNING id,title,service,severity,status,details,created_at,updated_at
            """, (title, service, severity, details)).fetchone()
            conn.execute('INSERT INTO activity (incident_id,action,note) VALUES (%s,%s,%s)',
                         (row['id'], 'created', 'Insiden dicatat: ' + title[:280]))
        return jsonify(incident=row), 201
    except Exception:
        return jsonify(error='Insiden gagal disimpan. Coba lagi setelah koneksi database pulih.'), 503


@app.patch('/api/incidents/<int:incident_id>')
@require_login
def resolve_incident(incident_id):
    error = require_csrf()
    if error:
        return error
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify(error='Format permintaan tidak valid.'), 400
    if data.get('action') == 'edit':
        title = data.get('title', '').strip() if isinstance(data.get('title'), str) else ''
        service = data.get('service', '').strip() if isinstance(data.get('service'), str) else ''
        details = data.get('details', '').strip() if isinstance(data.get('details'), str) else ''
        severity = data.get('severity')
        if not 3 <= len(title) <= 120 or not 2 <= len(service) <= 80 or len(details) > 1200:
            return jsonify(error='Judul (3–120) dan layanan (2–80) wajib diisi; detail maksimal 1200 karakter.'), 400
        if severity not in ('low', 'medium', 'high', 'critical'):
            return jsonify(error='Pilih tingkat dampak yang tersedia.'), 400
        try:
            with connect() as conn:
                row = conn.execute("""
                    UPDATE incidents SET title=%s,service=%s,severity=%s,details=%s,updated_at=now()
                    WHERE id=%s RETURNING id,title,service,severity,status,details,created_at,updated_at
                """, (title, service, severity, details, incident_id)).fetchone()
                if not row:
                    return jsonify(error='Insiden tidak ditemukan.'), 404
                conn.execute('INSERT INTO activity (incident_id,action,note) VALUES (%s,%s,%s)',
                             (incident_id, 'updated', 'Insiden diperbarui: ' + title[:250]))
            return jsonify(incident=row)
        except Exception:
            return jsonify(error='Insiden gagal diperbarui. Coba lagi setelah koneksi database pulih.'), 503
    if data.get('action') != 'resolve':
        return jsonify(error='Aksi insiden tidak dikenal.'), 400
    try:
        with connect() as conn:
            row = conn.execute("""
                UPDATE incidents SET status='resolved', updated_at=now()
                WHERE id=%s AND status='open' RETURNING id
            """, (incident_id,)).fetchone()
            if not row:
                return jsonify(error='Insiden tidak ditemukan atau sudah selesai.'), 404
            conn.execute('INSERT INTO activity (incident_id,action,note) VALUES (%s,%s,%s)',
                         (incident_id, 'resolved', 'Incident marked as resolved.'))
        return jsonify(ok=True)
    except Exception:
        return jsonify(error='Status insiden gagal diperbarui.'), 503


@app.delete('/api/incidents/<int:incident_id>')
@require_login
def delete_incident(incident_id):
    error = require_csrf()
    if error:
        return error
    try:
        with connect() as conn:
            row = conn.execute('SELECT title FROM incidents WHERE id=%s', (incident_id,)).fetchone()
            if not row:
                return jsonify(error='Insiden tidak ditemukan.'), 404
            conn.execute('INSERT INTO activity (incident_id,action,note) VALUES (%s,%s,%s)',
                         (incident_id, 'deleted', 'Insiden dihapus: ' + row['title'][:250]))
            conn.execute('DELETE FROM incidents WHERE id=%s', (incident_id,))
        return jsonify(ok=True)
    except Exception:
        return jsonify(error='Insiden gagal dihapus.'), 503


@app.get('/api/activity')
@require_login
def activity():
    try:
        with connect() as conn:
            rows = conn.execute("""
                SELECT a.id,a.incident_id,a.action,a.note,a.created_at,i.title
                FROM activity a LEFT JOIN incidents i ON i.id=a.incident_id
                ORDER BY a.created_at DESC LIMIT 12
            """).fetchall()
        return jsonify(activity=rows)
    except Exception:
        return jsonify(error='Riwayat aktivitas tidak bisa dibaca.'), 503


@app.errorhandler(413)
def too_large(_):
    return jsonify(error='Permintaan terlalu besar.'), 413


@app.errorhandler(404)
def not_found(_):
    if request.path.startswith('/api/'):
        return jsonify(error='Endpoint not found.'), 404
    return 'Halaman tidak ditemukan.', 404


init_db()
