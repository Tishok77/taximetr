// Основная логика приложения: состояние смены, таймеры, экраны.

(() => {
  const viewRoot = document.getElementById('view-root');
  const modalPayment = document.getElementById('modal-payment');
  const inputPayment = document.getElementById('input-payment');
  const modalExpense = document.getElementById('modal-expense');

  function migrateShiftFormat(s) {
    if (s && !s.modeStats) {
      // миграция старого формата смены (без разбивки простоя по режимам)
      s.modeStats = { flexible: { idleSeconds: s.idleSeconds || 0 }, efficient: { idleSeconds: 0 } };
      delete s.idleSeconds;
    }
    return s;
  }

  let shift = migrateShiftFormat(AppStorage.getCurrentShift()); // текущая активная смена или null
  let currentUser = null; // заполняется, только если доступен сервер и есть вход
  let tickInterval = null;
  let pendingOrderEnd = null; // { durationSec, distanceKm } на время открытой модалки оплаты
  let pendingExpenseType = null; // 'fuel' | 'electricity' | 'fine' на время открытой модалки расхода

  // ---------- Утилиты форматирования ----------

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatHMS(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
  }

  function formatKm(km) {
    return `${km.toFixed(1)} км`;
  }

  function formatMoney(value) {
    return `${Math.round(value).toLocaleString('ru-RU')} ₽`;
  }

  function formatDateTime(ts) {
    return new Date(ts).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function dateInputToTs(dateStr) {
    // считаем полдень локального времени, чтобы избежать смещения дня из-за часового пояса
    return new Date(`${dateStr}T12:00:00`).getTime();
  }

  function tsToDateInput(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function monthKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function monthLabel(key) {
    const [year, month] = key.split('-').map(Number);
    const d = new Date(year, month - 1, 1);
    const label = d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function formatSheetDateTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function makeId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // ---------- Вычисления по смене ----------

  function elapsedSince(ts, now) {
    return Math.max(0, (now - ts) / 1000);
  }

  const MODES = ['flexible', 'efficient'];

  function modeLabel(mode) {
    return mode === 'efficient' ? 'Эффективный' : 'Гибкий';
  }

  const EXPENSE_TYPES = {
    fuel: { label: 'Заправка', quantityLabel: 'Литры', quantityUnit: 'л' },
    electricity: { label: 'Зарядка', quantityLabel: 'Киловатт-часы', quantityUnit: 'кВт·ч' },
    fine: { label: 'Штраф', quantityLabel: null, quantityUnit: null },
  };

  // Комиссии агрегатора/парка вычитаются из суммы, введённой водителем (цена до комиссии)
  function commissionPct(commissions, mode) {
    const m = commissions[mode] || {};
    return Object.values(m).reduce((sum, v) => sum + (Number(v) || 0), 0);
  }

  function netAmount(gross, commissions, mode) {
    return gross * (1 - commissionPct(commissions, mode) / 100);
  }

  function idleSecondsForMode(s, mode, now) {
    const accumulated = (s.modeStats[mode] && s.modeStats[mode].idleSeconds) || 0;
    const live = !s.endedAt && s.state === 'idle' && s.mode === mode ? elapsedSince(s.segmentStartedAt, now) : 0;
    return accumulated + live;
  }

  function computeLiveStats(s, now) {
    const ordersDoneSec = s.orders.reduce((sum, o) => sum + o.durationSec, 0);
    const currentOrderSec = !s.endedAt && s.state === 'order' ? elapsedSince(s.currentOrder.startedAt, now) : 0;
    const idleSec = MODES.reduce((sum, mode) => sum + idleSecondsForMode(s, mode, now), 0);
    const breakSec = s.breakSeconds + (!s.endedAt && s.state === 'break' ? elapsedSince(s.segmentStartedAt, now) : 0);
    const shiftSec = elapsedSince(s.startedAt, now);
    return {
      ordersSec: ordersDoneSec + currentOrderSec,
      idleSec,
      breakSec,
      shiftSec,
      distanceKm: s.distanceKm,
    };
  }

  // Разбивка времени/дохода по режиму работы (для переключения режима без завершения смены)
  function computeModeBreakdown(s, now) {
    const commissions = AppStorage.getCommissionSettings();
    return MODES.map((mode) => {
      const modeOrders = s.orders.filter((o) => (o.mode || s.mode) === mode);
      const ordersSec = modeOrders.reduce((sum, o) => sum + o.durationSec, 0) +
        (!s.endedAt && s.state === 'order' && s.currentOrder.mode === mode ? elapsedSince(s.currentOrder.startedAt, now) : 0);
      const idleSec = idleSecondsForMode(s, mode, now);
      return {
        mode,
        lineSec: ordersSec + idleSec,
        ordersCount: modeOrders.length,
        grossEarnings: modeOrders.reduce((sum, o) => sum + o.payment, 0),
        netEarnings: modeOrders.reduce((sum, o) => sum + netAmount(o.payment, commissions, mode), 0),
      };
    });
  }

  // Закрывает текущий отрезок простоя, накопив его время в статистику активного режима
  function closeIdleSegment(now) {
    shift.modeStats[shift.mode].idleSeconds += elapsedSince(shift.segmentStartedAt, now);
  }

  // ---------- Выгрузка в Google Таблицы ----------

  function buildExportPayload() {
    const history = AppStorage.getHistory();
    const commissions = AppStorage.getCommissionSettings();
    const shiftsHeader = [
      'Дата начала', 'Дата окончания', 'Режим (на конец)', 'Общее время смены',
      'Время на линии', 'В заказах', 'Простой', 'Обед', 'Пробег, км',
      'Заказов', 'Доход до комиссии, ₽', 'Доход чистыми, ₽', 'Эффективность, %',
      'Доход/час чистыми, ₽', 'Доход/км чистыми, ₽',
    ];
    const ordersHeader = [
      'Смена (дата начала)', '№ заказа', 'Режим', 'Начало', 'Конец', 'Длительность',
      'Пробег, км', 'Оплата до комиссии, ₽', 'Оплата чистыми, ₽',
    ];

    const shiftRows = [];
    const orderRows = [];

    history.slice().reverse().forEach((s) => {
      const now = s.endedAt;
      const stats = computeLiveStats(s, now);
      const lineSec = Math.max(0, stats.shiftSec - stats.breakSec);
      const grossEarnings = s.orders.reduce((sum, o) => sum + o.payment, 0);
      const netEarnings = s.orders.reduce((sum, o) => sum + netAmount(o.payment, commissions, o.mode || s.mode), 0);
      const efficiencyPct = lineSec > 0 ? (stats.ordersSec / lineSec) * 100 : 0;
      const perHour = lineSec > 0 ? netEarnings / (lineSec / 3600) : 0;
      const perKm = stats.distanceKm > 0 ? netEarnings / stats.distanceKm : 0;

      shiftRows.push([
        formatSheetDateTime(s.startedAt),
        formatSheetDateTime(s.endedAt),
        modeLabel(s.mode),
        formatHMS(stats.shiftSec),
        formatHMS(lineSec),
        formatHMS(stats.ordersSec),
        formatHMS(stats.idleSec),
        formatHMS(stats.breakSec),
        Number(stats.distanceKm.toFixed(2)),
        s.orders.length,
        Math.round(grossEarnings),
        Math.round(netEarnings),
        Number(efficiencyPct.toFixed(1)),
        Math.round(perHour),
        Math.round(perKm),
      ]);

      s.orders.forEach((o, i) => {
        orderRows.push([
          formatSheetDateTime(s.startedAt),
          i + 1,
          modeLabel(o.mode || s.mode),
          formatSheetDateTime(o.startedAt),
          formatSheetDateTime(o.endedAt),
          formatHMS(o.durationSec),
          Number(o.distanceKm.toFixed(2)),
          Math.round(o.payment),
          Math.round(netAmount(o.payment, commissions, o.mode || s.mode)),
        ]);
      });
    });

    const expensesHeader = ['Дата', 'Тип', 'Количество', 'Ед. изм.', 'Сумма, ₽', 'Комментарий'];
    const expenseRows = AppStorage.getExpenses()
      .slice()
      .reverse()
      .map((e) => [
        formatSheetDateTime(e.date).split(' ')[0],
        EXPENSE_TYPES[e.type].label,
        e.quantity == null ? '' : e.quantity,
        EXPENSE_TYPES[e.type].quantityUnit || '',
        Math.round(e.amount),
        e.comment || '',
      ]);

    const reportHeader = [
      'Месяц', 'Доход чистыми, ₽', 'Бензин, ₽', 'Электричество, ₽', 'Штрафы, ₽',
      'Всего расходов, ₽', 'Прибыль, ₽', 'Пробег, км', 'Смен', 'Заказов',
    ];
    const reportRows = computeMonthlyReport()
      .slice()
      .reverse()
      .map((m) => [
        monthLabel(m.key),
        Math.round(m.netIncome),
        Math.round(m.fuelAmount),
        Math.round(m.electricityAmount),
        Math.round(m.finesAmount),
        Math.round(m.expensesTotal),
        Math.round(m.profit),
        Number(m.distanceKm.toFixed(1)),
        m.shiftsCount,
        m.ordersCount,
      ]);

    return {
      sheets: {
        'Смены': [shiftsHeader, ...shiftRows],
        'Заказы': [ordersHeader, ...orderRows],
        'Расходы': [expensesHeader, ...expenseRows],
        'Отчёт по месяцам': [reportHeader, ...reportRows],
      },
    };
  }

  async function exportToSheets(onStatus) {
    const url = AppStorage.getSheetsUrl().trim();
    if (!url) { onStatus('Сначала укажите и сохраните ссылку', 'error'); return; }

    onStatus('Отправка...', '');
    const payload = buildExportPayload();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let ok = res.ok;
      try {
        const json = JSON.parse(text);
        ok = ok && json.ok !== false;
      } catch (e) { /* ответ не JSON — доверяем res.ok */ }
      onStatus(ok ? 'Готово! Данные выгружены в таблицу.' : 'Что-то пошло не так. Проверьте ссылку и доступ к скрипту.', ok ? 'ok' : 'error');
    } catch (err) {
      onStatus('Не удалось отправить данные. Проверьте интернет и ссылку.', 'error');
    }
  }

  // ---------- Персистентность ----------

  function persist() {
    AppStorage.saveCurrentShift(shift);
    AppApi.scheduleSync(shift);
  }

  // ---------- GPS ----------

  function startGps() {
    GeoTracker.start(
      (deltaKm) => {
        if (!shift) return;
        shift.distanceKm += deltaKm;
        persist();
      },
      (err) => {
        console.warn('Геолокация недоступна:', err.message || err);
      }
    );
  }

  function stopGps() {
    GeoTracker.stop();
  }

  // ---------- Тикер (обновление таймеров раз в секунду) ----------

  function startTicker(renderFn) {
    stopTicker();
    tickInterval = setInterval(renderFn, 1000);
  }

  function stopTicker() {
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  }

  // ---------- Рендер: экран "Начать смену" ----------

  function renderStart() {
    stopTicker();
    viewRoot.innerHTML = '';
    const tpl = document.getElementById('tpl-start').content.cloneNode(true);
    viewRoot.appendChild(tpl);

    let selectedMode = 'flexible';
    const modeBtns = viewRoot.querySelectorAll('.mode-btn');
    modeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        modeBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        selectedMode = btn.dataset.mode;
      });
    });

    document.getElementById('btn-start-shift').addEventListener('click', () => {
      const now = Date.now();
      shift = {
        id: makeId(),
        mode: selectedMode,
        startedAt: now,
        endedAt: null,
        state: 'idle',
        segmentStartedAt: now,
        modeStats: { flexible: { idleSeconds: 0 }, efficient: { idleSeconds: 0 } },
        breakSeconds: 0,
        distanceKm: 0,
        orders: [],
        currentOrder: null,
      };
      persist();
      startGps();
      renderShift();
    });
  }

  // ---------- Рендер: экран активной смены ----------

  function renderShift() {
    viewRoot.innerHTML = '';
    const tpl = document.getElementById('tpl-shift').content.cloneNode(true);
    viewRoot.appendChild(tpl);

    const badge = document.getElementById('status-badge');
    const orderPanel = document.getElementById('order-panel');
    const btnBreak = document.getElementById('btn-toggle-break');
    const btnEnd = document.getElementById('btn-end-shift');
    const modeButtons = viewRoot.querySelectorAll('#shift-mode-switch .mode-btn');

    function renderOrderPanel(now) {
      orderPanel.innerHTML = '';
      if (shift.state === 'order') {
        const sec = elapsedSince(shift.currentOrder.startedAt, now);
        const distSoFar = Math.max(0, shift.distanceKm - shift.currentOrder.distanceAtStart);
        orderPanel.innerHTML = `
          <div class="timer-block">
            <div class="timer-label">Заказ в пути · ${formatKm(distSoFar)}</div>
            <div class="timer">${formatHMS(sec)}</div>
          </div>
          <button class="btn btn-success btn-lg" id="btn-end-order">Завершить заказ</button>
        `;
        document.getElementById('btn-end-order').addEventListener('click', onEndOrderClick);
      } else if (shift.state === 'break') {
        orderPanel.innerHTML = `<p class="empty-hint">Вы на обеде. Нажмите «Закончить обед», чтобы вернуться на линию.</p>`;
      } else {
        orderPanel.innerHTML = `<button class="btn btn-primary btn-lg" id="btn-start-order">Начать заказ</button>`;
        document.getElementById('btn-start-order').addEventListener('click', onStartOrderClick);
      }
    }

    function renderOrdersList() {
      const list = document.getElementById('orders-list');
      const count = document.getElementById('orders-count');
      count.textContent = shift.orders.length;
      list.innerHTML = shift.orders
        .slice()
        .reverse()
        .map((o, i) => orderItemHtml(shift.orders.length - i, o))
        .join('');
    }

    function tick() {
      const now = Date.now();
      const stats = computeLiveStats(shift, now);

      badge.textContent = shift.state === 'order' ? 'В заказе' : shift.state === 'break' ? 'На обеде' : 'На линии';
      badge.className = 'status-badge ' + (shift.state === 'order' ? 'order' : shift.state === 'break' ? 'break' : 'idle');

      document.getElementById('timer-shift').textContent = formatHMS(stats.shiftSec);
      document.getElementById('stat-orders-time').textContent = formatHMS(stats.ordersSec);
      document.getElementById('stat-idle-time').textContent = formatHMS(stats.idleSec);
      document.getElementById('stat-break-time').textContent = formatHMS(stats.breakSec);
      document.getElementById('stat-distance').textContent = formatKm(stats.distanceKm);

      renderOrderPanel(now);

      btnBreak.textContent = shift.state === 'break' ? 'Закончить обед' : 'Обед';
      btnBreak.disabled = shift.state === 'order';
      btnEnd.disabled = shift.state === 'order';

      modeButtons.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === shift.mode);
        btn.disabled = shift.state === 'order';
      });
    }

    function onStartOrderClick() {
      if (shift.state !== 'idle') return;
      const now = Date.now();
      closeIdleSegment(now);
      shift.state = 'order';
      shift.segmentStartedAt = now;
      shift.currentOrder = { startedAt: now, distanceAtStart: shift.distanceKm, mode: shift.mode };
      persist();
      tick();
    }

    function onEndOrderClick() {
      if (shift.state !== 'order') return;
      const now = Date.now();
      const durationSec = elapsedSince(shift.currentOrder.startedAt, now);
      const distanceKm = Math.max(0, shift.distanceKm - shift.currentOrder.distanceAtStart);
      pendingOrderEnd = { durationSec, distanceKm };
      document.getElementById('modal-order-time').textContent = formatHMS(durationSec);
      document.getElementById('modal-order-distance').textContent = formatKm(distanceKm);
      inputPayment.value = '';
      modalPayment.hidden = false;
      inputPayment.focus();
    }

    btnBreak.addEventListener('click', () => {
      const now = Date.now();
      if (shift.state === 'idle') {
        closeIdleSegment(now);
        shift.state = 'break';
        shift.segmentStartedAt = now;
      } else if (shift.state === 'break') {
        shift.breakSeconds += elapsedSince(shift.segmentStartedAt, now);
        shift.state = 'idle';
        shift.segmentStartedAt = now;
      }
      persist();
      tick();
    });

    modeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const newMode = btn.dataset.mode;
        if (newMode === shift.mode || shift.state === 'order') return;
        const now = Date.now();
        if (shift.state === 'idle') {
          closeIdleSegment(now);
          shift.segmentStartedAt = now;
        }
        shift.mode = newMode;
        persist();
        tick();
      });
    });

    btnEnd.addEventListener('click', () => {
      if (shift.state === 'order') return;
      const now = Date.now();
      if (shift.state === 'idle') closeIdleSegment(now);
      if (shift.state === 'break') shift.breakSeconds += elapsedSince(shift.segmentStartedAt, now);
      shift.segmentStartedAt = now; // отрезок закрыт, чтобы итоги не досчитали его повторно
      shift.endedAt = now;
      stopGps();
      stopTicker();
      const finished = shift;
      AppStorage.addToHistory(finished);
      AppStorage.clearCurrentShift();
      AppApi.cancelScheduledSync();
      AppApi.pushFinishShift(finished);
      shift = null;
      renderSummary(finished, { backTo: 'start' });
    });

    renderOrdersList();
    tick();
    startTicker(() => { tick(); renderOrdersList(); });

    // Обработчики модалки оплаты (общие, но переустанавливаем при каждом рендере смены)
    document.getElementById('btn-cancel-payment').onclick = () => {
      modalPayment.hidden = true;
      pendingOrderEnd = null;
    };
    document.getElementById('btn-confirm-payment').onclick = () => {
      const payment = parseFloat(inputPayment.value);
      if (!pendingOrderEnd || isNaN(payment) || payment < 0) return;
      const order = {
        id: makeId(),
        startedAt: shift.currentOrder.startedAt,
        endedAt: Date.now(),
        durationSec: pendingOrderEnd.durationSec,
        distanceKm: pendingOrderEnd.distanceKm,
        mode: shift.currentOrder.mode,
        payment,
      };
      shift.orders.push(order);
      shift.state = 'idle';
      shift.segmentStartedAt = Date.now();
      shift.currentOrder = null;
      pendingOrderEnd = null;
      persist();
      modalPayment.hidden = true;
      tick();
      renderOrdersList();
    };
  }

  function orderItemHtml(num, o) {
    const commissions = AppStorage.getCommissionSettings();
    const net = netAmount(o.payment, commissions, o.mode || 'flexible');
    return `
      <li class="order-item">
        <div class="oi-left">
          <span class="oi-num">Заказ №${num}</span>
          <span class="oi-meta">${formatTime(o.startedAt)}–${formatTime(o.endedAt)} · ${formatHMS(o.durationSec)} · ${formatKm(o.distanceKm)} · до комиссии ${formatMoney(o.payment)}</span>
        </div>
        <div class="oi-payment">${formatMoney(net)}</div>
      </li>
    `;
  }

  // ---------- Рендер: итоги смены ----------

  function renderSummary(finishedShift, opts) {
    stopTicker();
    viewRoot.innerHTML = '';
    const tpl = document.getElementById('tpl-summary').content.cloneNode(true);
    viewRoot.appendChild(tpl);

    const now = finishedShift.endedAt;
    const stats = computeLiveStats(finishedShift, now);
    const lineSec = Math.max(0, stats.shiftSec - stats.breakSec);
    const commissions = AppStorage.getCommissionSettings();
    const grossEarnings = finishedShift.orders.reduce((sum, o) => sum + o.payment, 0);
    const netEarnings = finishedShift.orders.reduce((sum, o) => sum + netAmount(o.payment, commissions, o.mode || finishedShift.mode), 0);
    const efficiencyPct = lineSec > 0 ? (stats.ordersSec / lineSec) * 100 : 0;
    const perHour = lineSec > 0 ? netEarnings / (lineSec / 3600) : 0;
    const perKm = stats.distanceKm > 0 ? netEarnings / stats.distanceKm : 0;

    const cards = [
      { label: 'Режим работы (на конец смены)', value: modeLabel(finishedShift.mode) },
      { label: 'Смена', value: `${formatDateTime(finishedShift.startedAt)} – ${formatDateTime(finishedShift.endedAt)}` , wide: true },
      { label: 'Общее время смены', value: formatHMS(stats.shiftSec) },
      { label: 'Время на линии', value: formatHMS(lineSec) },
      { label: 'В заказах', value: formatHMS(stats.ordersSec) },
      { label: 'Простой', value: formatHMS(stats.idleSec) },
      { label: 'Обед', value: formatHMS(stats.breakSec) },
      { label: 'Пробег', value: formatKm(stats.distanceKm) },
      { label: 'Эффективность', value: `${efficiencyPct.toFixed(0)}%`, highlight: true },
      { label: 'Доход чистыми', value: formatMoney(netEarnings), highlight: true, wide: true },
      { label: 'Доход до комиссии', value: formatMoney(grossEarnings) },
      { label: 'Доход в час чистыми (на линии)', value: formatMoney(perHour) },
      { label: 'Доход за 1 км чистыми', value: formatMoney(perKm) },
    ];

    document.getElementById('summary-grid').innerHTML = cards.map((c) => `
      <div class="summary-card ${c.wide ? 'wide' : ''} ${c.highlight ? 'highlight' : ''}">
        <div class="sc-value">${c.value}</div>
        <div class="sc-label">${c.label}</div>
      </div>
    `).join('');

    const breakdown = computeModeBreakdown(finishedShift, now);
    document.getElementById('mode-breakdown-grid').innerHTML = breakdown.map((b) => `
      <div class="summary-card wide">
        <div class="sc-value">${formatMoney(b.netEarnings)} чистыми</div>
        <div class="sc-label">${modeLabel(b.mode)} · ${formatHMS(b.lineSec)} на линии · ${b.ordersCount} заказ(ов) · ${formatMoney(b.grossEarnings)} до комиссии</div>
      </div>
    `).join('');

    document.getElementById('summary-orders-count').textContent = finishedShift.orders.length;
    document.getElementById('summary-orders-list').innerHTML = finishedShift.orders
      .map((o, i) => orderItemHtml(i + 1, o))
      .join('') || '<p class="empty-hint">За эту смену не было заказов</p>';

    document.getElementById('btn-close-summary').addEventListener('click', () => {
      if (opts && opts.backTo === 'history') renderHistory();
      else renderStart();
    });
  }

  // ---------- Рендер: история смен ----------

  function renderHistory() {
    stopTicker();
    viewRoot.innerHTML = '';
    const tpl = document.getElementById('tpl-history').content.cloneNode(true);
    viewRoot.appendChild(tpl);

    const history = AppStorage.getHistory();
    const list = document.getElementById('shift-history-list');
    const emptyHint = document.getElementById('history-empty-hint');

    function renderList() {
      const currentHistory = AppStorage.getHistory();
      if (currentHistory.length === 0) {
        emptyHint.hidden = false;
        list.innerHTML = '';
        return;
      }
      emptyHint.hidden = true;
      const commissions = AppStorage.getCommissionSettings();
      list.innerHTML = currentHistory.map((s) => {
        const earnings = s.orders.reduce((sum, o) => sum + netAmount(o.payment, commissions, o.mode || s.mode), 0);
        return `
          <li class="shift-item" data-id="${s.id}">
            <div class="si-left">
              <span class="oi-num">${formatDateTime(s.startedAt)}</span>
              <span class="si-meta">${modeLabel(s.mode)} · ${s.orders.length} заказ(ов) · ${formatKm(s.distanceKm)}</span>
            </div>
            <div class="si-right">
              <div class="oi-payment">${formatMoney(earnings)}</div>
              <button class="delete-shift-btn" data-id="${s.id}">Удалить</button>
            </div>
          </li>
        `;
      }).join('');

      list.querySelectorAll('.shift-item').forEach((el) => {
        el.addEventListener('click', () => {
          const s = AppStorage.getHistory().find((h) => h.id === el.dataset.id);
          if (s) renderSummary(s, { backTo: 'history' });
        });
      });

      list.querySelectorAll('.delete-shift-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const s = AppStorage.getHistory().find((h) => h.id === btn.dataset.id);
          const label = s ? formatDateTime(s.startedAt) : '';
          if (!confirm(`Удалить смену от ${label}? Это действие нельзя отменить.`)) return;
          AppStorage.saveHistory(AppStorage.getHistory().filter((h) => h.id !== btn.dataset.id));
          AppApi.pushDeleteShift(btn.dataset.id);
          renderList();
        });
      });
    }

    renderList();

    const sheetsUrlInput = document.getElementById('input-sheets-url');
    const exportStatus = document.getElementById('export-status');
    sheetsUrlInput.value = AppStorage.getSheetsUrl();

    function setExportStatus(text, kind) {
      exportStatus.textContent = text;
      exportStatus.className = 'export-status ' + (kind || '');
    }

    document.getElementById('btn-save-sheets-url').addEventListener('click', () => {
      const url = sheetsUrlInput.value.trim();
      AppStorage.saveSheetsUrl(url);
      AppApi.pushSettings(null, url);
      setExportStatus('Ссылка сохранена', 'ok');
    });

    document.getElementById('btn-export-sheets').addEventListener('click', () => {
      exportToSheets(setExportStatus);
    });

    document.getElementById('btn-history-back').addEventListener('click', () => {
      if (shift) renderShift();
      else renderStart();
    });
  }

  document.getElementById('btn-history').addEventListener('click', () => renderHistory());

  // ---------- Рендер: настройки комиссий ----------

  function renderSettings() {
    stopTicker();
    viewRoot.innerHTML = '';
    const tpl = document.getElementById('tpl-settings').content.cloneNode(true);
    viewRoot.appendChild(tpl);

    const commissions = AppStorage.getCommissionSettings();
    document.getElementById('comm-flexible-service').value = commissions.flexible.service;
    document.getElementById('comm-flexible-mode').value = commissions.flexible.mode;
    document.getElementById('comm-flexible-park').value = commissions.flexible.park;
    document.getElementById('comm-efficient-service').value = commissions.efficient.service;
    document.getElementById('comm-efficient-park').value = commissions.efficient.park;

    const status = document.getElementById('commission-save-status');

    document.getElementById('btn-save-commissions').addEventListener('click', () => {
      const newCommissions = {
        flexible: {
          service: parseFloat(document.getElementById('comm-flexible-service').value) || 0,
          mode: parseFloat(document.getElementById('comm-flexible-mode').value) || 0,
          park: parseFloat(document.getElementById('comm-flexible-park').value) || 0,
        },
        efficient: {
          service: parseFloat(document.getElementById('comm-efficient-service').value) || 0,
          park: parseFloat(document.getElementById('comm-efficient-park').value) || 0,
        },
      };
      AppStorage.saveCommissionSettings(newCommissions);
      AppApi.pushSettings(newCommissions, null);
      status.textContent = 'Сохранено';
      status.className = 'export-status ok';
    });

    document.getElementById('btn-settings-back').addEventListener('click', () => {
      if (shift) renderShift();
      else renderStart();
    });
  }

  document.getElementById('btn-settings').addEventListener('click', () => renderSettings());

  // ---------- Рендер: расходы ----------

  function renderExpenses() {
    stopTicker();
    viewRoot.innerHTML = '';
    const tpl = document.getElementById('tpl-expenses').content.cloneNode(true);
    viewRoot.appendChild(tpl);

    const list = document.getElementById('expenses-list');
    const emptyHint = document.getElementById('expenses-empty-hint');
    const totalsGrid = document.getElementById('expenses-totals');

    function renderList() {
      const expenses = AppStorage.getExpenses();

      const fuel = expenses.filter((e) => e.type === 'fuel');
      const electricity = expenses.filter((e) => e.type === 'electricity');
      const fines = expenses.filter((e) => e.type === 'fine');
      const fuelTotal = fuel.reduce((sum, e) => sum + e.amount, 0);
      const fuelLiters = fuel.reduce((sum, e) => sum + (e.quantity || 0), 0);
      const electricityTotal = electricity.reduce((sum, e) => sum + e.amount, 0);
      const electricityKwh = electricity.reduce((sum, e) => sum + (e.quantity || 0), 0);
      const finesTotal = fines.reduce((sum, e) => sum + e.amount, 0);

      totalsGrid.innerHTML = `
        <div class="stat"><div class="stat-value">${formatMoney(fuelTotal)}</div><div class="stat-label">Бензин (${fuelLiters.toFixed(1)} л)</div></div>
        <div class="stat"><div class="stat-value">${formatMoney(electricityTotal)}</div><div class="stat-label">Электричество (${electricityKwh.toFixed(1)} кВт·ч)</div></div>
        <div class="stat"><div class="stat-value">${formatMoney(finesTotal)}</div><div class="stat-label">Штрафы</div></div>
        <div class="stat"><div class="stat-value">${formatMoney(fuelTotal + electricityTotal + finesTotal)}</div><div class="stat-label">Всего расходов</div></div>
      `;

      if (expenses.length === 0) {
        emptyHint.hidden = false;
        list.innerHTML = '';
        return;
      }
      emptyHint.hidden = true;

      list.innerHTML = expenses.map((e) => {
        const meta = e.type === 'fine'
          ? formatDate(e.date) + (e.comment ? ' · ' + e.comment : '')
          : `${formatDate(e.date)} · ${e.quantity} ${EXPENSE_TYPES[e.type].quantityUnit}${e.comment ? ' · ' + e.comment : ''}`;
        return `
          <li class="order-item">
            <div class="oi-left">
              <span class="expense-type-badge ${e.type}">${EXPENSE_TYPES[e.type].label}</span>
              <span class="oi-meta">${meta}</span>
            </div>
            <div class="si-right">
              <div class="oi-payment">${formatMoney(e.amount)}</div>
              <button class="delete-shift-btn" data-id="${e.id}">Удалить</button>
            </div>
          </li>
        `;
      }).join('');

      list.querySelectorAll('.delete-shift-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!confirm('Удалить эту запись о расходе?')) return;
          AppStorage.saveExpenses(AppStorage.getExpenses().filter((x) => x.id !== btn.dataset.id));
          AppApi.pushDeleteExpense(btn.dataset.id);
          renderList();
        });
      });
    }

    renderList();

    function openExpenseModal(type) {
      pendingExpenseType = type;
      const meta = EXPENSE_TYPES[type];
      document.getElementById('expense-modal-title').textContent = 'Добавить: ' + meta.label;
      document.getElementById('input-expense-date').value = tsToDateInput(Date.now());
      document.getElementById('input-expense-amount').value = '';
      document.getElementById('input-expense-comment').value = '';
      const quantityField = document.getElementById('expense-quantity-field');
      if (meta.quantityLabel) {
        quantityField.hidden = false;
        document.getElementById('expense-quantity-label').textContent = meta.quantityLabel;
        document.getElementById('input-expense-quantity').value = '';
      } else {
        quantityField.hidden = true;
      }
      modalExpense.hidden = false;
    }

    document.getElementById('btn-add-fuel').addEventListener('click', () => openExpenseModal('fuel'));
    document.getElementById('btn-add-electricity').addEventListener('click', () => openExpenseModal('electricity'));
    document.getElementById('btn-add-fine').addEventListener('click', () => openExpenseModal('fine'));

    document.getElementById('btn-cancel-expense').onclick = () => {
      modalExpense.hidden = true;
      pendingExpenseType = null;
    };

    document.getElementById('btn-confirm-expense').onclick = () => {
      if (!pendingExpenseType) return;
      const dateStr = document.getElementById('input-expense-date').value;
      const amount = parseFloat(document.getElementById('input-expense-amount').value);
      const comment = document.getElementById('input-expense-comment').value.trim();
      const meta = EXPENSE_TYPES[pendingExpenseType];
      let quantity = null;
      if (meta.quantityLabel) {
        quantity = parseFloat(document.getElementById('input-expense-quantity').value);
        if (isNaN(quantity) || quantity < 0) return;
      }
      if (!dateStr || isNaN(amount) || amount < 0) return;

      const expense = {
        id: makeId(),
        type: pendingExpenseType,
        date: dateInputToTs(dateStr),
        amount,
        quantity,
        comment,
      };
      AppStorage.addExpense(expense);
      AppApi.pushAddExpense(expense);

      modalExpense.hidden = true;
      pendingExpenseType = null;
      renderList();
    };

    document.getElementById('btn-expenses-back').addEventListener('click', () => {
      if (shift) renderShift();
      else renderStart();
    });
  }

  document.getElementById('btn-expenses').addEventListener('click', () => renderExpenses());

  // ---------- Отчёт по месяцам ----------

  function computeMonthlyReport() {
    const history = AppStorage.getHistory();
    const expenses = AppStorage.getExpenses();
    const commissions = AppStorage.getCommissionSettings();
    const months = {};

    function getMonth(key) {
      if (!months[key]) {
        months[key] = {
          key,
          netIncome: 0, grossIncome: 0, distanceKm: 0, ordersCount: 0, shiftsCount: 0,
          fuelAmount: 0, fuelLiters: 0,
          electricityAmount: 0, electricityKwh: 0,
          finesAmount: 0,
        };
      }
      return months[key];
    }

    history.forEach((s) => {
      const m = getMonth(monthKey(s.startedAt));
      m.grossIncome += s.orders.reduce((sum, o) => sum + o.payment, 0);
      m.netIncome += s.orders.reduce((sum, o) => sum + netAmount(o.payment, commissions, o.mode || s.mode), 0);
      m.distanceKm += s.distanceKm;
      m.ordersCount += s.orders.length;
      m.shiftsCount += 1;
    });

    expenses.forEach((e) => {
      const m = getMonth(monthKey(e.date));
      if (e.type === 'fuel') { m.fuelAmount += e.amount; m.fuelLiters += (e.quantity || 0); }
      else if (e.type === 'electricity') { m.electricityAmount += e.amount; m.electricityKwh += (e.quantity || 0); }
      else if (e.type === 'fine') { m.finesAmount += e.amount; }
    });

    return Object.values(months)
      .map((m) => {
        const expensesTotal = m.fuelAmount + m.electricityAmount + m.finesAmount;
        return { ...m, expensesTotal, profit: m.netIncome - expensesTotal };
      })
      .sort((a, b) => b.key.localeCompare(a.key));
  }

  function renderReport() {
    stopTicker();
    viewRoot.innerHTML = '';
    const tpl = document.getElementById('tpl-report').content.cloneNode(true);
    viewRoot.appendChild(tpl);

    const months = computeMonthlyReport();
    const container = document.getElementById('report-months');
    const emptyHint = document.getElementById('report-empty-hint');

    if (months.length === 0) {
      emptyHint.hidden = false;
    } else {
      emptyHint.hidden = true;
      container.innerHTML = months.map((m) => `
        <div class="report-month-card">
          <h3>${monthLabel(m.key)}</h3>
          <div class="summary-grid">
            <div class="summary-card wide highlight">
              <div class="sc-value">${formatMoney(m.profit)}</div>
              <div class="sc-label">Прибыль (доход чистыми минус все расходы)</div>
            </div>
            <div class="summary-card wide">
              <div class="sc-value">${formatMoney(m.netIncome)}</div>
              <div class="sc-label">Доход чистыми · ${m.shiftsCount} смен(ы) · ${m.ordersCount} заказ(ов)</div>
            </div>
            <div class="summary-card">
              <div class="sc-value">${formatMoney(m.fuelAmount)}</div>
              <div class="sc-label">Бензин (${m.fuelLiters.toFixed(1)} л)</div>
            </div>
            <div class="summary-card">
              <div class="sc-value">${formatMoney(m.electricityAmount)}</div>
              <div class="sc-label">Электричество (${m.electricityKwh.toFixed(1)} кВт·ч)</div>
            </div>
            <div class="summary-card">
              <div class="sc-value">${formatMoney(m.finesAmount)}</div>
              <div class="sc-label">Штрафы</div>
            </div>
            <div class="summary-card">
              <div class="sc-value">${formatKm(m.distanceKm)}</div>
              <div class="sc-label">Пробег за месяц</div>
            </div>
          </div>
        </div>
      `).join('');
    }

    document.getElementById('btn-report-back').addEventListener('click', () => {
      if (shift) renderShift();
      else renderStart();
    });
  }

  document.getElementById('btn-report').addEventListener('click', () => renderReport());

  // ---------- Вход / регистрация (только когда доступен сервер) ----------

  function showAuthedNav(user) {
    currentUser = user;
    document.getElementById('btn-logout').hidden = false;
    document.getElementById('btn-admin-panel').hidden = user.role !== 'admin';
  }

  function hideAuthedNav() {
    currentUser = null;
    document.getElementById('btn-logout').hidden = true;
    document.getElementById('btn-admin-panel').hidden = true;
  }

  function renderAuth(initialMode) {
    stopTicker();
    viewRoot.innerHTML = '';
    const tpl = document.getElementById('tpl-auth').content.cloneNode(true);
    viewRoot.appendChild(tpl);

    let mode = initialMode || 'login';
    const title = document.getElementById('auth-title');
    const nameField = document.getElementById('auth-name-field');
    const submitBtn = document.getElementById('btn-auth-submit');
    const toggleBtn = document.getElementById('btn-auth-toggle');
    const status = document.getElementById('auth-status');

    function applyMode() {
      if (mode === 'login') {
        title.textContent = 'Вход';
        nameField.hidden = true;
        submitBtn.textContent = 'Войти';
        toggleBtn.textContent = 'Нет аккаунта? Зарегистрироваться';
      } else {
        title.textContent = 'Регистрация';
        nameField.hidden = false;
        submitBtn.textContent = 'Зарегистрироваться';
        toggleBtn.textContent = 'Уже есть аккаунт? Войти';
      }
      status.textContent = '';
      status.className = 'export-status';
    }
    applyMode();

    toggleBtn.addEventListener('click', () => {
      mode = mode === 'login' ? 'register' : 'login';
      applyMode();
    });

    submitBtn.addEventListener('click', async () => {
      const email = document.getElementById('auth-email').value.trim();
      const password = document.getElementById('auth-password').value;
      const name = document.getElementById('auth-name').value.trim();

      status.textContent = 'Подождите...';
      status.className = 'export-status';
      submitBtn.disabled = true;

      const result = mode === 'login'
        ? await AppApi.login(email, password)
        : await AppApi.register(email, password, name);

      submitBtn.disabled = false;

      if (!result || result.ok !== true) {
        status.textContent = (result && result.error) || 'Ошибка. Попробуйте ещё раз.';
        status.className = 'export-status error';
        return;
      }

      showAuthedNav(result.user);
      await AppApi.pullState();
      shift = migrateShiftFormat(AppStorage.getCurrentShift());
      if (shift) { startGps(); renderShift(); } else { renderStart(); }
    });
  }

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await AppApi.logout();
    stopGps();
    stopTicker();
    AppStorage.clearCurrentShift();
    AppStorage.saveHistory([]);
    AppStorage.saveExpenses([]);
    shift = null;
    hideAuthedNav();
    renderAuth('login');
  });

  // ---------- Рендер: панель администратора ----------

  async function renderAdmin() {
    stopTicker();
    viewRoot.innerHTML = '';
    const tpl = document.getElementById('tpl-admin').content.cloneNode(true);
    viewRoot.appendChild(tpl);

    const list = document.getElementById('admin-users-list');
    const emptyHint = document.getElementById('admin-empty-hint');
    list.innerHTML = '<p class="empty-hint">Загрузка...</p>';

    const data = await AppApi.listUsers();

    if (!data || data.ok !== true) {
      list.innerHTML = '';
      emptyHint.hidden = false;
      emptyHint.textContent = (data && data.error) || 'Не удалось загрузить список пользователей';
    } else {
      const users = data.users || [];
      if (users.length === 0) {
        list.innerHTML = '';
        emptyHint.hidden = false;
        emptyHint.textContent = 'Пока нет других пользователей';
      } else {
        emptyHint.hidden = true;
        list.innerHTML = users.map((u) => `
          <li class="shift-item">
            <div class="si-left">
              <span class="oi-num">${u.name} <span class="expense-type-badge ${u.role === 'admin' ? 'fine' : 'fuel'}">${u.role === 'admin' ? 'Админ' : 'Водитель'}</span></span>
              <span class="si-meta">${u.email} · ${u.shiftsCount} смен(ы) · ${u.ordersCount} заказ(ов) · ${formatKm(u.distanceKm)}</span>
              <span class="si-meta">${u.lastShiftStartedAt ? 'Последняя смена: ' + formatDateTime(u.lastShiftStartedAt) : 'Смен ещё не было'}</span>
            </div>
            <div class="oi-payment">${formatMoney(u.grossPayment)}</div>
          </li>
        `).join('');
      }
    }

    document.getElementById('btn-admin-back').addEventListener('click', () => {
      if (shift) renderShift();
      else renderStart();
    });
  }

  document.getElementById('btn-admin-panel').addEventListener('click', () => renderAdmin());

  // ---------- Инициализация ----------

  async function bootstrap() {
    const backendAvailable = await AppApi.ping();

    if (backendAvailable) {
      const user = await AppApi.me();
      if (!user) {
        renderAuth('login');
        registerServiceWorker();
        return;
      }
      showAuthedNav(user);
      await AppApi.pullState();
      shift = migrateShiftFormat(AppStorage.getCurrentShift());
    }

    if (shift) {
      startGps();
      renderShift();
    } else {
      renderStart();
    }

    registerServiceWorker();
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch((err) => {
          console.warn('Не удалось зарегистрировать service worker:', err);
        });
      });
    }
  }

  bootstrap();
})();
