(() => {
  const $ = (selector) => document.querySelector(selector);
  const state = { csrf: '', filter: 'all', incidents: [] };
  const loginScreen = $('#login');
  const application = $('#application');
  const toast = $('#toast');
  let toastTimer;

  async function api(path, options = {}) {
    const headers = { 'Accept': 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
    if (state.csrf && options.method && options.method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && path !== '/api/login') showLogin();
      throw new Error(data.error || 'Permintaan gagal. Coba lagi.');
    }
    return data;
  }

  function showToast(message, isError = false) {
    toast.textContent = message;
    toast.classList.toggle('is-error', isError);
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 3800);
  }
  function showLogin() { application.hidden = true; loginScreen.hidden = false; $('#password').focus(); }
  function showApp() { loginScreen.hidden = true; application.hidden = false; updateClock(); loadDashboard(); }
  function updateClock() {
    const now = new Date();
    $('#local-clock').textContent = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false }).format(now) + ' WIB';
    $('#today').textContent = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);
  }
  function timeAgo(value) {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    if (seconds < 60) return 'baru saja';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' menit lalu';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' jam lalu';
    return new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }).format(new Date(value));
  }
  function make(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function setDb(connected) {
    $('#db-dot').classList.toggle('down', !connected);
    $('#db-status').textContent = connected ? 'Database tersambung' : 'Database terputus';
    $('#metric-db').textContent = connected ? 'Siap' : 'Terputus';
    $('#metric-db').classList.toggle('value-down', !connected);
    $('#system-note').textContent = connected ? 'Aplikasi merespons dan koneksi PostgreSQL aktif. Data baru dapat disimpan.' : 'Aplikasi terbuka, tetapi database belum merespons. Catatan baru belum bisa disimpan.';
  }
  async function loadDashboard() {
    const results = await Promise.allSettled([
      api('/api/summary'),
      api('/api/incidents?status=' + encodeURIComponent(state.filter)),
      api('/api/activity')
    ]);
    const summary = results[0];
    if (summary.status === 'fulfilled') {
      setDb(true);
      $('#metric-open').textContent = summary.value.open;
      $('#metric-urgent').textContent = summary.value.urgent;
      $('#metric-today').textContent = summary.value.today;
      $('#nav-open-count').textContent = summary.value.open;
      $('#filter-open-count').textContent = summary.value.open;
    } else {
      setDb(false);
      ['#metric-open', '#metric-urgent', '#metric-today', '#nav-open-count', '#filter-open-count'].forEach((id) => { $(id).textContent = '—'; });
    }
    if (results[1].status === 'fulfilled') { state.incidents = results[1].value.incidents; renderIncidents(); }
    else renderError('#incident-list', results[1].reason.message);
    if (results[2].status === 'fulfilled') renderActivity(results[2].value.activity);
    else renderError('#activity-list', results[2].reason.message);
    $('#last-updated').textContent = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }).format(new Date());
    $('#list-foot').textContent = state.incidents.length ? 'Menampilkan ' + state.incidents.length + ' catatan terbaru' : '';
  }
  function renderError(selector, message) {
    const target = $(selector);
    target.hidden = false;
    target.replaceChildren(make('p', 'inline-error', message));
    if (selector === '#incident-list') {
      state.incidents = [];
      $('#empty-state').hidden = true;
      $('#list-foot').textContent = '';
    }
  }

  const severityLabel = { low: 'Rendah', medium: 'Sedang', high: 'Tinggi', critical: 'Kritis' };
  function renderIncidents() {
    const list = $('#incident-list');
    const query = $('#search').value.trim().toLocaleLowerCase('id');
    const filtered = state.incidents.filter((item) => [item.title, item.service, item.details].some((v) => (v || '').toLocaleLowerCase('id').includes(query)));
    list.replaceChildren();
    $('#empty-state').hidden = state.incidents.length > 0;
    if (!state.incidents.length) { list.hidden = true; $('#list-foot').textContent = ''; return; }
    list.hidden = false;
    if (!filtered.length) { list.append(make('div', 'no-results', 'Tidak ada insiden yang cocok dengan pencarian.')); return; }
    for (const item of filtered) {
      const row = make('article', 'incident-row ' + (item.status === 'resolved' ? 'is-resolved' : ''));
      const severity = make('span', 'severity-mark severity-' + item.severity);
      severity.setAttribute('aria-label', severityLabel[item.severity]);
      const body = make('div', 'incident-main');
      body.append(make('h3', 'incident-title', item.title));
      const meta = make('div', 'incident-meta');
      meta.append(make('span', 'service-label', item.service), make('span', 'meta-dot', '·'), make('span', 'severity-text', severityLabel[item.severity]), make('span', 'meta-dot', '·'), make('time', '', timeAgo(item.created_at)));
      body.append(meta);
      if (item.details) body.append(make('p', 'incident-detail', item.details));
      const action = item.status === 'open' ? make('button', 'resolve-button', 'Tandai selesai') : make('span', 'resolved-label', 'Selesai');
      if (item.status === 'open') {
        action.type = 'button';
        action.setAttribute('aria-label', 'Tandai insiden ' + item.title + ' selesai');
        action.addEventListener('click', () => resolve(item.id, action));
      }
      const side = make('div', 'incident-side');
      const buttons = make('div', 'row-actions');
      const edit = make('button', 'text-button row-edit', 'Ubah');
      edit.type = 'button'; edit.setAttribute('aria-label', 'Ubah insiden ' + item.title);
      edit.addEventListener('click', () => openDialog(item));
      const remove = make('button', 'row-delete', 'Hapus');
      remove.type = 'button'; remove.setAttribute('aria-label', 'Hapus insiden ' + item.title);
      remove.addEventListener('click', () => deleteIncident(item.id, item.title, remove));
      buttons.append(edit, remove);
      side.append(make('span', 'status-pill ' + item.status, item.status === 'open' ? 'Terbuka' : 'Selesai'), action, buttons);
      row.append(severity, body, side);
      list.append(row);
    }
  }
  function renderActivity(items) {
    const list = $('#activity-list');
    list.replaceChildren();
    $('#activity-empty').hidden = items.length > 0;
    for (const item of items) {
      const entry = make('div', 'activity-entry');
      const actionLabel = { created: 'Insiden dicatat', updated: 'Insiden diperbarui', deleted: 'Insiden dihapus', resolved: 'Insiden diselesaikan' };
      entry.append(make('span', 'activity-mark ' + (item.action === 'resolved' ? 'done' : ''), item.action === 'resolved' ? '✓' : item.action === 'deleted' ? '−' : '+'));
      const copy = make('div', 'activity-copy');
      copy.append(make('p', '', actionLabel[item.action] || 'Aktivitas insiden'));
      if (item.title) copy.append(make('span', '', item.title));
      else if (item.action === 'deleted' && item.note) copy.append(make('span', '', item.note.replace(/^Insiden dihapus: /, '')));
      copy.append(make('time', '', timeAgo(item.created_at)));
      entry.append(copy);
      list.append(entry);
    }
  }
  async function resolve(id, button) {
    button.disabled = true;
    try { await api('/api/incidents/' + id, { method: 'PATCH', body: JSON.stringify({ action: 'resolve' }) }); showToast('Insiden ditandai selesai.'); await loadDashboard(); }
    catch (error) { button.disabled = false; showToast(error.message, true); }
  }

  async function deleteIncident(id, title, button) {
    if (!window.confirm('Hapus catatan “' + title + '”? Tindakan ini tidak bisa dibatalkan.')) return;
    button.disabled = true;
    try { await api('/api/incidents/' + id, { method: 'DELETE' }); showToast('Catatan insiden dihapus.'); await loadDashboard(); }
    catch (error) { button.disabled = false; showToast(error.message, true); }
  }

  const dialog = $('#incident-dialog');
  function openDialog(item = null) {
    $('#incident-form').reset(); $('#incident-error').hidden = true;
    $('#incident-id').value = item ? item.id : '';
    $('#dialog-title').textContent = item ? 'Ubah insiden' : 'Catat insiden';
    $('#save-incident').textContent = item ? 'Simpan perubahan' : 'Simpan catatan';
    if (item) {
      $('#incident-title').value = item.title; $('#incident-service').value = item.service;
      $('#incident-severity').value = item.severity; $('#incident-details').value = item.details || '';
    }
    dialog.showModal(); setTimeout(() => $('#incident-title').focus(), 40);
  }
  $('#new-incident').addEventListener('click', openDialog);
  $('#empty-create').addEventListener('click', openDialog);
  $('#close-dialog').addEventListener('click', () => dialog.close());
  $('#cancel-dialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  $('#incident-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#save-incident');
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    button.disabled = true; button.textContent = 'Menyimpan…'; $('#incident-error').hidden = true;
    try {
      const incidentId = payload.incidentId; delete payload.incidentId;
      await api(incidentId ? '/api/incidents/' + incidentId : '/api/incidents', {
        method: incidentId ? 'PATCH' : 'POST', body: JSON.stringify(incidentId ? { ...payload, action: 'edit' } : payload)
      });
      dialog.close(); showToast(incidentId ? 'Perubahan insiden tersimpan.' : 'Catatan tersimpan di PostgreSQL.');
      if (!incidentId) {
        state.filter = 'all';
        document.querySelectorAll('.filter-tab').forEach((tab) => tab.classList.toggle('selected', tab.dataset.filter === 'all'));
      }
      await loadDashboard();
    } catch (error) { $('#incident-error').textContent = error.message; $('#incident-error').hidden = false; }
    finally { button.disabled = false; button.textContent = $('#incident-id').value ? 'Simpan perubahan' : 'Simpan catatan'; }
  });
  document.querySelectorAll('.filter-tab').forEach((tab) => tab.addEventListener('click', async () => {
    state.filter = tab.dataset.filter;
    document.querySelectorAll('.filter-tab').forEach((item) => item.classList.toggle('selected', item === tab));
    await loadDashboard();
  }));
  $('#search').addEventListener('input', renderIncidents);
  $('#logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch (_) {}
    state.csrf = ''; showLogin();
  });
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true; button.textContent = 'Memeriksa…'; $('#login-error').hidden = true;
    try {
      const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
      state.csrf = result.csrfToken; $('#password').value = ''; showApp();
    } catch (error) { $('#login-error').textContent = error.message; $('#login-error').hidden = false; $('#password').select(); }
    finally { button.disabled = false; button.innerHTML = 'Masuk ke pos jaga <span aria-hidden="true">→</span>'; }
  });
  api('/api/session').then((session) => {
    if (session.authenticated) { state.csrf = session.csrfToken; showApp(); } else showLogin();
  }).catch(showLogin);
  setInterval(updateClock, 30000);
  setInterval(() => { if (!application.hidden) loadDashboard(); }, 60000);
})();
