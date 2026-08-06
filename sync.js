// Тонкий слой синхронизации с сервером (PHP + MySQL).
// Если рядом нет api/*.php (например, на GitHub Pages), backendAvailable
// останется false и приложение продолжит работать полностью локально,
// как раньше — ничего в остальном коде специально проверять не нужно.

const AppApi = (() => {
  let backendAvailable = null; // null = ещё не проверяли
  let syncTimer = null;

  async function request(path, options) {
    try {
      const res = await fetch(path, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      let data = null;
      try { data = await res.json(); } catch (e) { /* ответ не JSON */ }
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: null };
    }
  }

  async function ping() {
    if (backendAvailable !== null) return backendAvailable;
    const { ok, data } = await request('api/auth.php?action=me', { method: 'GET' });
    backendAvailable = ok && !!data && data.ok === true;
    return backendAvailable;
  }

  async function me() {
    const { data } = await request('api/auth.php?action=me', { method: 'GET' });
    return data && data.user ? data.user : null;
  }

  async function register(email, password, name) {
    const { data } = await request('api/auth.php?action=register', {
      method: 'POST', body: JSON.stringify({ email, password, name }),
    });
    return data;
  }

  async function login(email, password) {
    const { data } = await request('api/auth.php?action=login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
    return data;
  }

  async function logout() {
    await request('api/auth.php?action=logout', { method: 'POST' });
  }

  async function pullState() {
    const { data } = await request('api/data.php?action=get_state', { method: 'GET' });
    if (!data || !data.ok) return;
    if (data.current) AppStorage.saveCurrentShift(data.current);
    else AppStorage.clearCurrentShift();
    AppStorage.saveHistory(data.history || []);
    AppStorage.saveExpenses(data.expenses || []);
    if (data.commissions) AppStorage.saveCommissionSettings(data.commissions);
    if (data.sheetsUrl) AppStorage.saveSheetsUrl(data.sheetsUrl);
  }

  function scheduleSync(shift) {
    if (!backendAvailable || !shift) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => pushCurrentShift(shift), 20000);
  }

  function cancelScheduledSync() {
    clearTimeout(syncTimer);
  }

  function pushCurrentShift(shift) {
    if (!backendAvailable || !shift) return;
    request('api/data.php?action=save_current_shift', { method: 'POST', body: JSON.stringify({ shift }) });
  }

  function pushFinishShift(shift) {
    if (!backendAvailable || !shift) return;
    return request('api/data.php?action=finish_shift', { method: 'POST', body: JSON.stringify({ shift }) });
  }

  function pushDeleteShift(id) {
    if (!backendAvailable) return;
    request('api/data.php?action=delete_shift', { method: 'POST', body: JSON.stringify({ id }) });
  }

  function pushAddExpense(expense) {
    if (!backendAvailable) return;
    request('api/data.php?action=add_expense', { method: 'POST', body: JSON.stringify({ expense }) });
  }

  function pushDeleteExpense(id) {
    if (!backendAvailable) return;
    request('api/data.php?action=delete_expense', { method: 'POST', body: JSON.stringify({ id }) });
  }

  function pushSettings(commissions, sheetsUrl) {
    if (!backendAvailable) return;
    request('api/data.php?action=save_settings', { method: 'POST', body: JSON.stringify({ commissions, sheetsUrl }) });
  }

  async function listUsers() {
    const { data } = await request('api/admin.php?action=list_users', { method: 'GET' });
    return data;
  }

  return {
    ping, me, register, login, logout, pullState,
    scheduleSync, cancelScheduledSync, pushCurrentShift, pushFinishShift, pushDeleteShift,
    pushAddExpense, pushDeleteExpense, pushSettings, listUsers,
    isAvailable: () => backendAvailable,
  };
})();
