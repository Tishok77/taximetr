// Основная логика приложения: состояние смены, таймеры, экраны.

(() => {
  const viewRoot = document.getElementById('view-root');
  const modalPayment = document.getElementById('modal-payment');
  const inputPayment = document.getElementById('input-payment');

  let shift = AppStorage.getCurrentShift(); // текущая активная смена или null
  if (shift && !shift.modeStats) {
    // миграция старого формата смены (без разбивки простоя по режимам)
    shift.modeStats = { flexible: { idleSeconds: shift.idleSeconds || 0 }, efficient: { idleSeconds: 0 } };
    delete shift.idleSeconds;
  }
  let tickInterval = null;
  let pendingOrderEnd = null; // { durationSec, distanceKm } на время открытой модалки оплаты

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

  function idleSecondsForMode(s, mode, now) {
    const accumulated = (s.modeStats[mode] && s.modeStats[mode].idleSeconds) || 0;
    const live = s.state === 'idle' && s.mode === mode ? elapsedSince(s.segmentStartedAt, now) : 0;
    return accumulated + live;
  }

  function computeLiveStats(s, now) {
    const ordersDoneSec = s.orders.reduce((sum, o) => sum + o.durationSec, 0);
    const currentOrderSec = s.state === 'order' ? elapsedSince(s.currentOrder.startedAt, now) : 0;
    const idleSec = MODES.reduce((sum, mode) => sum + idleSecondsForMode(s, mode, now), 0);
    const breakSec = s.breakSeconds + (s.state === 'break' ? elapsedSince(s.segmentStartedAt, now) : 0);
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
    return MODES.map((mode) => {
      const modeOrders = s.orders.filter((o) => (o.mode || s.mode) === mode);
      const ordersSec = modeOrders.reduce((sum, o) => sum + o.durationSec, 0) +
        (s.state === 'order' && s.currentOrder.mode === mode ? elapsedSince(s.currentOrder.startedAt, now) : 0);
      const idleSec = idleSecondsForMode(s, mode, now);
      return {
        mode,
        lineSec: ordersSec + idleSec,
        ordersCount: modeOrders.length,
        earnings: modeOrders.reduce((sum, o) => sum + o.payment, 0),
      };
    });
  }

  // Закрывает текущий отрезок простоя, накопив его время в статистику активного режима
  function closeIdleSegment(now) {
    shift.modeStats[shift.mode].idleSeconds += elapsedSince(shift.segmentStartedAt, now);
  }

  // ---------- Персистентность ----------

  function persist() {
    AppStorage.saveCurrentShift(shift);
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
      shift.endedAt = now;
      stopGps();
      stopTicker();
      const finished = shift;
      AppStorage.addToHistory(finished);
      AppStorage.clearCurrentShift();
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
    return `
      <li class="order-item">
        <div class="oi-left">
          <span class="oi-num">Заказ №${num}</span>
          <span class="oi-meta">${formatTime(o.startedAt)}–${formatTime(o.endedAt)} · ${formatHMS(o.durationSec)} · ${formatKm(o.distanceKm)}</span>
        </div>
        <div class="oi-payment">${formatMoney(o.payment)}</div>
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
    const totalEarnings = finishedShift.orders.reduce((sum, o) => sum + o.payment, 0);
    const efficiencyPct = lineSec > 0 ? (stats.ordersSec / lineSec) * 100 : 0;
    const perHour = lineSec > 0 ? totalEarnings / (lineSec / 3600) : 0;
    const perKm = stats.distanceKm > 0 ? totalEarnings / stats.distanceKm : 0;

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
      { label: 'Доход итого', value: formatMoney(totalEarnings), highlight: true, wide: true },
      { label: 'Доход в час (на линии)', value: formatMoney(perHour) },
      { label: 'Доход за 1 км', value: formatMoney(perKm) },
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
        <div class="sc-value">${formatHMS(b.lineSec)} на линии</div>
        <div class="sc-label">${modeLabel(b.mode)} · ${b.ordersCount} заказ(ов) · ${formatMoney(b.earnings)}</div>
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

    if (history.length === 0) {
      emptyHint.hidden = false;
      return;
    }

    list.innerHTML = history.map((s, i) => {
      const earnings = s.orders.reduce((sum, o) => sum + o.payment, 0);
      return `
        <li class="shift-item" data-index="${i}">
          <div class="si-left">
            <span class="oi-num">${formatDateTime(s.startedAt)}</span>
            <span class="si-meta">${modeLabel(s.mode)} · ${s.orders.length} заказ(ов) · ${formatKm(s.distanceKm)}</span>
          </div>
          <div class="oi-payment">${formatMoney(earnings)}</div>
        </li>
      `;
    }).join('');

    list.querySelectorAll('.shift-item').forEach((el) => {
      el.addEventListener('click', () => {
        const s = history[Number(el.dataset.index)];
        renderSummary(s, { backTo: 'history' });
      });
    });
  }

  document.getElementById('btn-history').addEventListener('click', () => renderHistory());

  // ---------- Инициализация ----------

  if (shift) {
    startGps();
    renderShift();
  } else {
    renderStart();
  }

  // ---------- Service worker (офлайн-доступность как PWA) ----------

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('Не удалось зарегистрировать service worker:', err);
      });
    });
  }
})();
