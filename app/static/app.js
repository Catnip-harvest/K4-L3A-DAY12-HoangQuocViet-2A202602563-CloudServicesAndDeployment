/*
 * Day 12 Agent — chat UI for the FastAPI service.
 * Plain browser JavaScript: no framework, no build step, no dependencies.
 *
 * Rules this file keeps:
 *   - server text is only ever written with textContent, never innerHTML;
 *   - the API key lives in sessionStorage only, is sent only as the X-API-Key
 *     header, and is never logged or placed in a URL;
 *   - every storage access is wrapped, so blocked storage degrades to memory.
 */
(function () {
  'use strict';

  // --- tunables -------------------------------------------------------------
  const MAX_QUESTION_CHARS = 2000;
  const SHOW_COUNTER_FROM = 1800;
  const ASK_TIMEOUT_MS = 70000;
  const STATUS_TIMEOUT_MS = 30000;
  const STATUS_INTERVAL_MS = 15000;
  const SLOW_HINT_AFTER_MS = 6000;
  const BURST_SIZE = 12;
  const DEFAULT_RETRY_AFTER_S = 60;

  const API_KEY_SLOT = 'day12-agent.api-key'; // sessionStorage only
  const USER_ID_SLOT = 'day12-agent.user-id'; // localStorage

  // Header values must be ISO-8859-1 or fetch() throws, so both are checked
  // before they are stored or sent.
  const API_KEY_PATTERN = /^[\x21-\x7E]{1,256}$/;
  const USER_ID_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;

  const COLD_START_HINT = 'Nếu máy chủ miễn phí vừa được đánh thức, lần gọi đầu có thể mất khoảng một phút.';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const noMatch = { matches: false };
  const reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : noMatch;
  const coarsePointer = window.matchMedia ? window.matchMedia('(pointer: coarse)') : noMatch;

  const clockFormat = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const usdFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });

  // --- storage --------------------------------------------------------------
  function openStorage(name) {
    try {
      const area = window[name];
      const probeSlot = 'day12-agent.probe';
      area.setItem(probeSlot, '1');
      area.removeItem(probeSlot);
      return area;
    } catch (error) {
      return null;
    }
  }

  const sessionArea = openStorage('sessionStorage');
  const localArea = openStorage('localStorage');

  function readSlot(area, slot) {
    if (!area) return '';
    try {
      return area.getItem(slot) || '';
    } catch (error) {
      return '';
    }
  }

  function writeSlot(area, slot, value) {
    if (!area) return;
    try {
      if (value) area.setItem(slot, value);
      else area.removeItem(slot);
    } catch (error) {
      // Storage refused the write; the value still lives in memory for this page.
    }
  }

  // --- small DOM helpers ----------------------------------------------------
  function el(tag, options, children) {
    const node = document.createElement(tag);
    const opts = options || {};
    if (opts.className) node.className = opts.className;
    if (opts.type) node.type = opts.type;
    if (opts.text !== undefined) node.textContent = opts.text;
    if (opts.attrs) {
      Object.keys(opts.attrs).forEach((name) => node.setAttribute(name, opts.attrs[name]));
    }
    if (opts.data) {
      Object.keys(opts.data).forEach((name) => { node.dataset[name] = opts.data[name]; });
    }
    (children || []).forEach((child) => { if (child) node.append(child); });
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  function actionButton(label, iconName, onClick) {
    const button = el('button', { className: 'btn btn--secondary btn--sm', type: 'button' }, [
      iconName ? icon(iconName) : null,
      el('span', { text: label }),
    ]);
    button.addEventListener('click', onClick);
    return button;
  }

  const byId = (id) => document.getElementById(id);

  const ui = {
    statusButton: byId('status-button'),
    statusLong: byId('status-long'),
    statusShort: byId('status-short'),
    statusPopover: byId('status-popover'),
    statusSummary: byId('status-summary'),
    healthCode: byId('health-code'),
    healthBody: byId('health-body'),
    readyCode: byId('ready-code'),
    readyBody: byId('ready-body'),
    statusTime: byId('status-time'),
    statusRefresh: byId('status-refresh'),
    connectButton: byId('connect-button'),
    connectUser: byId('connect-user'),
    sheet: byId('connect-sheet'),
    sheetForm: byId('connect-form'),
    sheetClose: byId('sheet-close'),
    sheetStatus: byId('sheet-status'),
    storageNote: byId('storage-note'),
    keyInput: byId('api-key'),
    keyToggle: byId('api-key-toggle'),
    keyToggleIcon: byId('api-key-toggle-icon'),
    keyError: byId('api-key-error'),
    userInput: byId('user-id'),
    userNew: byId('user-id-new'),
    userError: byId('user-id-error'),
    forgetKey: byId('forget-key'),
    scroller: byId('scroller'),
    empty: byId('empty'),
    emptyNote: byId('empty-note'),
    messages: byId('messages'),
    composer: byId('composer'),
    input: byId('question'),
    send: byId('send'),
    hint: byId('composer-hint'),
    counter: byId('composer-counter'),
    toolsToggle: byId('tools-toggle'),
    tools: byId('tools'),
    burst: byId('burst'),
    burstLabel: byId('burst-label'),
    burstResult: byId('burst-result'),
    burstChips: byId('burst-chips'),
    burstSummary: byId('burst-summary'),
    clear: byId('clear'),
    announcer: byId('announcer'),
  };

  const state = {
    apiKey: '',
    userId: '',
    pending: null, // AbortController of the in-flight /ask, if any
    burstRunning: false,
  };

  // --- formatting -----------------------------------------------------------
  function countChars(text) {
    // Code points, to match how the server (Python) measures max_length.
    return Array.from(text).length;
  }

  function toNumber(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '') return Number(value);
    return NaN;
  }

  function formatInteger(value) {
    const n = toNumber(value);
    return Number.isFinite(n) ? String(Math.round(n)) : '—';
  }

  function formatUsd(value) {
    const n = toNumber(value);
    return Number.isFinite(n) ? '$' + usdFormat.format(n) : '—';
  }

  function formatMessageCount(value) {
    const n = toNumber(value);
    return Number.isFinite(n) ? Math.round(n) + ' tin nhắn' : '—';
  }

  function textOrDash(value) {
    return typeof value === 'string' && value.trim() ? value : '—';
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return undefined;
    }
  }

  function parseRetryAfter(value) {
    let seconds = DEFAULT_RETRY_AFTER_S;
    if (value && /^\s*\d+\s*$/.test(value)) {
      seconds = parseInt(value, 10);
    } else if (value) {
      const at = Date.parse(value);
      if (Number.isFinite(at)) seconds = Math.ceil((at - Date.now()) / 1000);
    }
    return Math.min(3600, Math.max(1, seconds));
  }

  function serverDetail(body) {
    if (!body || typeof body !== 'object') return '';
    let detail = '';
    if (typeof body.detail === 'string') detail = body.detail;
    else if (Array.isArray(body.detail) && body.detail[0] && typeof body.detail[0].msg === 'string') detail = body.detail[0].msg;
    return detail.length > 200 ? detail.slice(0, 199) + '…' : detail;
  }

  function randomUserId() {
    const bytes = new Uint8Array(2);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      window.crypto.getRandomValues(bytes);
    } else {
      bytes[0] = Math.floor(Math.random() * 256);
      bytes[1] = Math.floor(Math.random() * 256);
    }
    return 'sv-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function announce(text) {
    ui.announcer.textContent = '';
    window.setTimeout(() => { ui.announcer.textContent = text; }, 60);
  }

  function focusComposer() {
    if (!coarsePointer.matches) ui.input.focus();
  }

  /** A button that was just disabled or removed drops focus to <body>; put it somewhere useful. */
  function rescueFocus(fallback) {
    const active = document.activeElement;
    if (active && active !== document.body && document.contains(active) && !active.disabled) return;
    if (fallback) fallback.focus();
    else focusComposer();
  }

  // --- network --------------------------------------------------------------
  function requestHeaders() {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (API_KEY_PATTERN.test(state.apiKey)) headers['X-API-Key'] = state.apiKey;
    if (USER_ID_PATTERN.test(state.userId)) headers['X-User-Id'] = state.userId;
    return headers;
  }

  /** POST /ask. Never throws; always resolves to a plain result object. */
  async function postAsk(question, controller) {
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, ASK_TIMEOUT_MS);
    const started = performance.now();
    try {
      const response = await fetch('/ask', {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({ question: question }),
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      const text = await response.text();
      return {
        kind: response.ok ? 'ok' : 'http',
        status: response.status,
        body: parseJson(text),
        retryAfter: parseRetryAfter(response.headers.get('Retry-After')),
        latencyMs: performance.now() - started,
      };
    } catch (error) {
      let kind = 'network';
      if (timedOut) kind = 'timeout';
      else if (controller.signal.aborted) kind = 'cancelled';
      return { kind: kind, status: 0, body: undefined };
    } finally {
      window.clearTimeout(timer);
    }
  }

  function isAnswer(body) {
    return Boolean(body) && typeof body === 'object' && typeof body.answer === 'string';
  }

  // --- service status (/health + /ready) ------------------------------------
  const STATUS_VIEWS = {
    checking: {
      tone: 'neutral', long: 'Đang kiểm tra', short: 'Đang kiểm tra',
      summary: 'Đang gọi /health và /ready. ' + COLD_START_HINT,
    },
    ready: {
      tone: 'ok', long: 'Sẵn sàng', short: 'Sẵn sàng',
      summary: 'Dịch vụ đang chạy và đã kết nối Redis.',
    },
    redis: {
      tone: 'warn', long: 'Redis chưa sẵn sàng', short: 'Chưa sẵn sàng',
      summary: 'Tiến trình vẫn chạy nhưng chưa kết nối được Redis, nên instance này tạm thời không nhận câu hỏi.',
    },
    notready: {
      tone: 'warn', long: 'Chưa sẵn sàng', short: 'Chưa sẵn sàng',
      summary: 'Tiến trình vẫn chạy nhưng /ready chưa báo sẵn sàng.',
    },
    stopping: {
      tone: 'danger', long: 'Đang tắt', short: 'Đang tắt',
      summary: 'Instance đang tắt dần và không nhận thêm yêu cầu mới.',
    },
    down: {
      tone: 'danger', long: 'Không kết nối được', short: 'Mất kết nối',
      summary: 'Không nhận được phản hồi hợp lệ từ /health. ' + COLD_START_HINT,
    },
  };

  const status = { inFlight: false, timer: 0, waitingForVisibility: false };

  async function probe(path) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
    try {
      const response = await fetch(path, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      const text = await response.text();
      return { reached: true, status: response.status, body: parseJson(text) };
    } catch (error) {
      return { reached: false, status: 0, body: undefined, timedOut: controller.signal.aborted };
    } finally {
      window.clearTimeout(timer);
    }
  }

  function saysShuttingDown(result) {
    return result.reached && Boolean(result.body) && result.body.status === 'shutting_down';
  }

  function classifyStatus(health, ready) {
    if (!health.reached) return 'down';
    if (saysShuttingDown(health) || saysShuttingDown(ready)) return 'stopping';
    if (health.status !== 200) return 'down';
    if (ready.reached && ready.status === 200 && ready.body && ready.body.status === 'ready') return 'ready';
    if (ready.reached && ready.body && ready.body.redis === false) return 'redis';
    return 'notready';
  }

  function renderProbe(codeNode, bodyNode, result, tone) {
    bodyNode.classList.remove('is-json');
    if (!result.reached) {
      codeNode.textContent = result.timedOut ? 'Hết giờ' : 'Không phản hồi';
      codeNode.dataset.tone = 'danger';
      bodyNode.textContent = result.timedOut
        ? 'Không có phản hồi sau ' + STATUS_TIMEOUT_MS / 1000 + ' giây.'
        : 'Không kết nối được tới máy chủ.';
      return;
    }
    codeNode.textContent = String(result.status);
    codeNode.dataset.tone = result.status >= 200 && result.status < 300 ? 'ok' : tone;
    if (result.body === undefined) {
      bodyNode.textContent = 'Nội dung trả về không phải JSON.';
    } else {
      bodyNode.textContent = JSON.stringify(result.body);
      bodyNode.classList.add('is-json');
    }
  }

  function renderStatus(key, health, ready) {
    const view = STATUS_VIEWS[key];
    ui.statusButton.dataset.state = key;
    ui.statusButton.dataset.tone = view.tone;
    ui.statusLong.textContent = view.long;
    ui.statusShort.textContent = view.short;
    ui.statusButton.setAttribute('aria-label', 'Trạng thái dịch vụ: ' + view.long + '. Bấm để xem chi tiết.');
    ui.statusSummary.textContent = view.summary;
    if (!health || !ready) return;
    const code = (result) => (result.reached ? String(result.status) : '—');
    ui.statusButton.title = 'health ' + code(health) + ' · ready ' + code(ready);
    renderProbe(ui.healthCode, ui.healthBody, health, view.tone);
    renderProbe(ui.readyCode, ui.readyBody, ready, view.tone);
    ui.statusTime.textContent = 'Cập nhật lúc ' + clockFormat.format(new Date()) + ' · tự kiểm tra mỗi 15 giây';
  }

  async function checkStatus() {
    if (status.inFlight) return;
    status.inFlight = true;
    window.clearTimeout(status.timer);
    ui.statusRefresh.disabled = true;
    try {
      const results = await Promise.all([probe('/health'), probe('/ready')]);
      renderStatus(classifyStatus(results[0], results[1]), results[0], results[1]);
    } finally {
      status.inFlight = false;
      ui.statusRefresh.disabled = false;
      scheduleStatusCheck();
    }
  }

  function scheduleStatusCheck() {
    window.clearTimeout(status.timer);
    status.timer = window.setTimeout(() => {
      // A hidden tab does not need a live pill; catch up when it is shown.
      if (document.hidden) {
        status.waitingForVisibility = true;
        return;
      }
      checkStatus();
    }, STATUS_INTERVAL_MS);
  }

  function setPopoverOpen(open) {
    ui.statusPopover.hidden = !open;
    ui.statusButton.setAttribute('aria-expanded', String(open));
  }

  // --- rate-limit cooldown --------------------------------------------------
  const cooldown = { until: 0, total: 0, timer: 0, views: new Set() };

  function cooldownMsLeft() {
    return Math.max(0, cooldown.until - Date.now());
  }

  function cooldownSecondsLeft() {
    return Math.ceil(cooldownMsLeft() / 1000);
  }

  function startCooldown(seconds) {
    const until = Date.now() + seconds * 1000;
    if (until > cooldown.until) {
      cooldown.until = until;
      cooldown.total = seconds * 1000;
    }
    if (!cooldown.timer) cooldown.timer = window.setInterval(tickCooldown, 250);
    tickCooldown();
  }

  function endCooldownEarly() {
    // The server just accepted a request, so any wait we were showing is over.
    if (cooldown.until > Date.now()) {
      cooldown.until = Date.now();
      tickCooldown();
    }
  }

  function tickCooldown() {
    const left = cooldownMsLeft();
    cooldown.views.forEach((view) => view.update(left, cooldown.total));
    if (left === 0) {
      window.clearInterval(cooldown.timer);
      cooldown.timer = 0;
      cooldown.views.forEach((view) => view.finish());
      cooldown.views.clear();
    }
    updateComposer();
  }

  function countdownView() {
    const seconds = el('b');
    const spoken = el('span', { className: 'sr-only', text: 'Có thể gửi lại sau ' + cooldownSecondsLeft() + ' giây.' });
    const visible = el('span', { attrs: { 'aria-hidden': 'true' } }, ['Có thể gửi lại sau ', seconds, ' giây']);
    const line = el('p', { className: 'notice__count' }, [spoken, visible]);
    const fill = el('span');
    const meter = el('div', { className: 'meter', attrs: { 'aria-hidden': 'true' } }, [fill]);
    const view = {
      update(msLeft, msTotal) {
        seconds.textContent = String(Math.ceil(msLeft / 1000));
        fill.style.transform = 'scaleX(' + (msTotal ? Math.min(1, msLeft / msTotal) : 0) + ')';
      },
      finish() {
        line.replaceChildren('Đã hết thời gian chờ, bạn có thể gửi lại.');
        line.classList.add('is-done');
        meter.hidden = true;
      },
    };
    view.update(cooldownMsLeft(), cooldown.total);
    if (cooldownMsLeft() > 0) cooldown.views.add(view);
    else view.finish();
    return [line, meter];
  }

  // --- composer -------------------------------------------------------------
  function isBusy() {
    return Boolean(state.pending) || state.burstRunning;
  }

  function canStartRequest() {
    return !isBusy() && cooldownSecondsLeft() === 0;
  }

  function autosize() {
    ui.input.style.height = 'auto';
    ui.input.style.height = ui.input.scrollHeight + 'px';
  }

  function setHint(text, tone, shortText) {
    // Phones get the short wording so the hint never wraps under the tools toggle.
    ui.hint.replaceChildren(
      el('span', { className: 'hint-long', text: text }),
      el('span', { className: 'hint-short', text: shortText || text })
    );
    ui.hint.classList.toggle('is-warn', tone === 'warn');
    ui.hint.classList.toggle('is-default', tone === 'default');
  }

  function updateComposer() {
    const text = ui.input.value.trim();
    const length = countChars(text);
    const over = length > MAX_QUESTION_CHARS;
    const waitSeconds = cooldownSecondsLeft();
    const blocked = isBusy() || waitSeconds > 0;

    ui.send.disabled = !text || over || blocked;

    ui.counter.hidden = length < SHOW_COUNTER_FROM;
    ui.counter.classList.toggle('is-over', over);
    ui.counter.textContent = over
      ? 'Vượt ' + (length - MAX_QUESTION_CHARS) + ' ký tự · tối đa ' + MAX_QUESTION_CHARS
      : length + ' / ' + MAX_QUESTION_CHARS;
    ui.input.setAttribute('aria-invalid', over ? 'true' : 'false');

    if (waitSeconds > 0) {
      setHint('Đang bị giới hạn tần suất · gửi lại sau ' + waitSeconds + ' giây', 'warn', 'Gửi lại sau ' + waitSeconds + ' giây');
    } else if (state.pending) {
      setHint('Đang chờ câu trả lời…', 'busy');
    } else if (state.burstRunning) {
      setHint('Đang chạy công cụ demo…', 'busy', 'Đang chạy demo…');
    } else {
      setHint('Enter để gửi · Shift + Enter để xuống dòng', 'default');
    }

    document.querySelectorAll('.suggestion, [data-retry]').forEach((button) => { button.disabled = blocked; });
    ui.burst.disabled = isBusy();
    ui.clear.disabled = isBusy();
  }

  function submitComposer() {
    const question = ui.input.value.trim();
    if (ui.send.disabled || !question) return;
    if (document.activeElement === ui.send) focusComposer();
    ui.input.value = '';
    autosize();
    askQuestion(question, null);
  }

  // --- conversation ---------------------------------------------------------
  let detailsCounter = 0;

  function setEmptyVisible(visible) {
    ui.empty.hidden = !visible;
  }

  function isNearBottom() {
    const s = ui.scroller;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 160;
  }

  function scrollToEnd() {
    window.requestAnimationFrame(() => {
      ui.scroller.scrollTo({ top: ui.scroller.scrollHeight, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    });
  }

  // Keep the newest message in view when the scroller shrinks (phone keyboard
  // opening, textarea growing, tools panel expanding) if the reader was
  // already at the bottom.
  let pinnedToBottom = true;

  function keepPinnedOnResize() {
    ui.scroller.addEventListener('scroll', () => { pinnedToBottom = isNearBottom(); }, { passive: true });
    if (typeof window.ResizeObserver !== 'function') return;
    new window.ResizeObserver(() => {
      if (pinnedToBottom) ui.scroller.scrollTop = ui.scroller.scrollHeight;
    }).observe(ui.scroller);
  }

  function appendMessage(node, forceScroll) {
    const follow = forceScroll || isNearBottom();
    setEmptyVisible(false);
    ui.messages.append(node);
    if (follow) scrollToEnd();
  }

  function userMessage(text) {
    return el('div', { className: 'msg msg--user' }, [
      el('p', { className: 'bubble bubble--user' }, [el('span', { className: 'sr-only', text: 'Bạn hỏi: ' }), text]),
    ]);
  }

  function systemNote(text) {
    return el('div', { className: 'msg msg--note' }, [el('p', { className: 'sysnote', text: text })]);
  }

  function answerMessage(body, latencyMs) {
    detailsCounter += 1;
    const detailsId = 'details-' + detailsCounter;
    const tokens = body.tokens && typeof body.tokens === 'object' ? body.tokens : {};
    const rows = [
      ['Token vào', formatInteger(tokens.in)],
      ['Token ra', formatInteger(tokens.out)],
      ['Chi phí', formatUsd(body.cost_usd)],
      ['Lịch sử trước lượt này', formatMessageCount(body.history_length)],
      ['Instance', textOrDash(body.instance), 'mono'],
      ['Độ trễ', Math.round(latencyMs) + ' ms'],
      ['Người dùng', textOrDash(body.user_id), 'mono'],
    ];

    const details = el('dl', { className: 'details', attrs: { id: detailsId } }, rows.map((row) =>
      el('div', { className: 'details__row' }, [
        el('dt', { text: row[0] }),
        el('dd', { className: row[2] === 'mono' ? 'mono' : '', text: row[1] }),
      ])
    ));
    details.hidden = true;

    const toggle = el('button', {
      className: 'disclose',
      type: 'button',
      attrs: { 'aria-expanded': 'false', 'aria-controls': detailsId },
    }, [el('span', { text: 'Chi tiết' }), icon('chevron-down')]);

    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      details.hidden = !open;
      if (open) details.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    });

    const answer = body.answer.trim() ? body.answer : '—';
    return el('div', { className: 'msg msg--agent' }, [
      el('div', { className: 'bubble bubble--agent' }, [
        el('p', { className: 'bubble__text' }, [el('span', { className: 'sr-only', text: 'Agent trả lời: ' }), answer]),
        toggle,
        details,
      ]),
    ]);
  }

  function thinkingMessage(onCancel) {
    const elapsed = el('span', { className: 'thinking__time', attrs: { 'aria-hidden': 'true' } });
    const hint = el('p', {
      className: 'thinking__hint',
      text: 'Máy chủ miễn phí có thể đang khởi động lại. Lần gọi đầu có thể mất khoảng một phút.',
    });
    hint.hidden = true;
    const cancel = actionButton('Huỷ', 'x', onCancel);
    cancel.hidden = true;

    const node = el('div', { className: 'msg msg--agent' }, [
      el('div', { className: 'thinking' }, [
        el('div', { className: 'thinking__row' }, [
          el('span', { className: 'dots', attrs: { 'aria-hidden': 'true' } }, [el('i'), el('i'), el('i')]),
          el('span', { text: 'Đang suy nghĩ' }),
          elapsed,
        ]),
        hint,
        cancel,
      ]),
    ]);

    const started = Date.now();
    const timer = window.setInterval(() => {
      const waited = Date.now() - started;
      const seconds = Math.floor(waited / 1000);
      if (seconds >= 2) elapsed.textContent = '· ' + seconds + ' giây';
      if (waited >= SLOW_HINT_AFTER_MS && hint.hidden) {
        hint.hidden = false;
        cancel.hidden = false;
      }
    }, 500);

    return {
      node: node,
      dispose() {
        window.clearInterval(timer);
        node.remove();
      },
    };
  }

  function describeFailure(result) {
    const detail = serverDetail(result.body);
    const timeoutSeconds = ASK_TIMEOUT_MS / 1000;

    if (result.kind === 'cancelled') {
      return { tone: 'neutral', icon: 'x', title: 'Đã huỷ câu hỏi', body: 'Câu hỏi đã được huỷ trước khi có câu trả lời.', actions: ['retry'] };
    }
    if (result.kind === 'timeout') {
      return {
        tone: 'danger', icon: 'clock', title: 'Máy chủ không trả lời sau ' + timeoutSeconds + ' giây',
        body: COLD_START_HINT + ' Hãy thử lại.', actions: ['retry'], refreshStatus: true,
      };
    }
    if (result.kind === 'network') {
      return {
        tone: 'danger', icon: 'circle-alert', title: 'Không kết nối được máy chủ',
        body: 'Kiểm tra kết nối mạng rồi thử lại. ' + COLD_START_HINT, actions: ['retry'], refreshStatus: true,
      };
    }
    if (result.kind === 'ok') {
      return {
        tone: 'danger', icon: 'circle-alert', title: 'Phản hồi không đúng định dạng',
        body: 'Máy chủ trả về thành công nhưng thiếu nội dung câu trả lời.', actions: ['retry'],
      };
    }

    switch (result.status) {
      case 401:
        return {
          tone: 'warn', icon: 'lock', title: 'Cần khoá API hợp lệ',
          body: state.apiKey
            ? 'Máy chủ từ chối khoá API hiện tại. Kiểm tra lại khoá rồi gửi lại.'
            : 'Bạn chưa nhập khoá API. Nhập khoá rồi gửi lại.',
          actions: ['key', 'retry'],
        };
      case 402:
        return {
          tone: 'warn', icon: 'wallet', title: 'Đã hết ngân sách tháng',
          body: 'Người dùng ' + state.userId + ' đã dùng hết ngân sách của tháng này. Máy chủ chặn trước khi gọi mô hình, nên không phát sinh thêm chi phí.',
          actions: [],
        };
      case 422:
        return {
          tone: 'warn', icon: 'circle-alert', title: 'Câu hỏi chưa hợp lệ',
          body: 'Câu hỏi cần có từ 1 đến ' + MAX_QUESTION_CHARS + ' ký tự.', detail: detail, actions: [],
        };
      case 429:
        return {
          tone: 'warn', icon: 'clock', title: 'Bạn đang gửi quá nhanh',
          body: 'Máy chủ giới hạn số câu hỏi mỗi phút cho từng người dùng. Câu hỏi này chưa được gửi tới mô hình.',
          countdown: true, actions: ['retry'],
        };
      case 503:
        return {
          tone: 'danger', icon: 'server', title: 'Dịch vụ tạm thời chưa sẵn sàng',
          body: 'Instance đang tắt dần hoặc chưa kết nối được Redis. Thử lại sau vài giây. ' + COLD_START_HINT,
          actions: ['retry'], refreshStatus: true,
        };
      default:
        break;
    }

    if (result.status >= 500) {
      return {
        tone: 'danger', icon: 'circle-alert', title: 'Máy chủ gặp lỗi',
        body: 'Thử lại sau ít phút. ' + COLD_START_HINT, actions: ['retry'], refreshStatus: true,
      };
    }
    return {
      tone: 'warn', icon: 'circle-alert', title: 'Yêu cầu bị từ chối',
      body: 'Máy chủ không chấp nhận yêu cầu này.', detail: detail, actions: ['retry'],
    };
  }

  function noticeMessage(result, question, info) {
    const node = el('div', { className: 'msg msg--agent' });
    const card = el('div', { className: 'notice notice--' + info.tone }, [
      el('div', { className: 'notice__head' }, [
        icon(info.icon),
        el('span', { text: info.title }),
        result.status ? el('span', { className: 'notice__code', text: 'HTTP ' + result.status }) : null,
      ]),
      el('p', { className: 'notice__body', text: info.body }),
    ]);

    if (info.detail) {
      card.append(el('p', { className: 'notice__detail' }, ['Máy chủ báo: ', el('code', { text: info.detail })]));
    }
    if (info.countdown) countdownView().forEach((part) => card.append(part));

    const actions = el('div', { className: 'notice__actions' });
    if (info.actions.indexOf('key') !== -1) {
      actions.append(actionButton('Nhập khoá API', 'key', () => openSheet('key')));
    }
    if (info.actions.indexOf('retry') !== -1) {
      const retry = actionButton('Thử lại', 'rotate-ccw', () => {
        if (canStartRequest()) askQuestion(question, node);
      });
      retry.dataset.retry = '';
      retry.disabled = !canStartRequest();
      actions.append(retry);
    }
    if (actions.childElementCount) card.append(actions);

    node.append(card);
    return node;
  }

  async function askQuestion(question, replacesNode) {
    if (!canStartRequest()) return;
    const length = countChars(question);
    if (length === 0 || length > MAX_QUESTION_CHARS) return;

    if (replacesNode) replacesNode.remove();
    else appendMessage(userMessage(question), true);

    const controller = new AbortController();
    const thinking = thinkingMessage(() => controller.abort());
    appendMessage(thinking.node, true);
    state.pending = controller;
    updateComposer();
    rescueFocus();

    const result = await postAsk(question, controller);

    thinking.dispose();
    state.pending = null;
    rescueFocus();

    if (result.kind === 'ok' && isAnswer(result.body)) {
      endCooldownEarly();
      appendMessage(answerMessage(result.body, result.latencyMs), false);
    } else {
      if (result.status === 429) startCooldown(result.retryAfter);
      const info = describeFailure(result);
      appendMessage(noticeMessage(result, question, info), false);
      if (info.refreshStatus) checkStatus();
    }
    updateComposer();
  }

  function clearScreen() {
    if (isBusy()) return;
    ui.messages.replaceChildren();
    cooldown.views.clear();
    ui.emptyNote.hidden = false;
    setEmptyVisible(true);
    announce('Đã xoá màn hình. Lịch sử trên máy chủ vẫn còn.');
    focusComposer();
  }

  // --- demo: 12 sequential requests ----------------------------------------
  function setChip(chip, index, chipState, label, spoken) {
    chip.dataset.state = chipState;
    chip.replaceChildren(
      el('span', { className: 'sr-only', text: 'Lượt ' + index + ': ' + (spoken || label) }),
      el('span', { text: label, attrs: { 'aria-hidden': 'true' } })
    );
    chip.title = 'Lượt ' + index + ': ' + (spoken || label);
  }

  async function runBurst() {
    if (isBusy()) return;
    state.burstRunning = true;
    updateComposer();

    const chips = [];
    ui.burstChips.replaceChildren();
    for (let i = 1; i <= BURST_SIZE; i += 1) {
      const chip = el('li', { className: 'code-chip' });
      setChip(chip, i, 'idle', '·', 'chưa gửi');
      chips.push(chip);
      ui.burstChips.append(chip);
    }
    ui.burstSummary.replaceChildren();
    ui.burstResult.hidden = false;

    const tally = new Map();
    let firstLimited = 0;
    let stopReason = '';
    let stoppedOnAuth = false;
    let serverLooksDown = false;

    for (let i = 0; i < BURST_SIZE; i += 1) {
      const index = i + 1;
      setChip(chips[i], index, 'pending', '…', 'đang gửi');
      ui.burstLabel.textContent = 'Đang gửi ' + index + '/' + BURST_SIZE + '…';

      const result = await postAsk('Kiểm tra rate limit ' + index + '/' + BURST_SIZE, new AbortController());
      const code = result.status;
      const label = code ? String(code) : 'ERR';
      let chipState = 'danger';
      if (code >= 200 && code < 300) chipState = 'ok';
      else if (code === 429) chipState = 'warn';
      setChip(chips[i], index, chipState, label, code ? 'mã ' + code : 'không kết nối được');
      tally.set(label, (tally.get(label) || 0) + 1);

      if (code === 429) {
        if (!firstLimited) firstLimited = index;
        startCooldown(result.retryAfter);
      } else if (code >= 200 && code < 300) {
        endCooldownEarly();
      }

      if (code === 401) stopReason = 'Dừng lại vì khoá API chưa đúng.';
      else if (code === 402) stopReason = 'Dừng lại vì đã hết ngân sách tháng.';
      else if (!code) stopReason = 'Dừng lại vì không kết nối được máy chủ.';
      else if (code >= 500) stopReason = 'Dừng lại vì máy chủ trả lỗi ' + code + '.';

      if (stopReason) {
        stoppedOnAuth = code === 401;
        serverLooksDown = !code || code >= 500;
        for (let j = i + 1; j < BURST_SIZE; j += 1) setChip(chips[j], j + 1, 'skipped', '–', 'không gửi');
        break;
      }
    }

    const counts = Array.from(tally, (entry) => entry[1] + ' × ' + entry[0]).join(' · ');
    let verdict;
    if (stopReason) verdict = stopReason;
    else if (firstLimited === 1) verdict = 'Hạn mức của phút này đã hết nên mọi request đều bị chặn.';
    else if (firstLimited) verdict = 'Rate limiter bắt đầu chặn từ request thứ ' + firstLimited + '.';
    else verdict = 'Chưa chạm giới hạn trong ' + BURST_SIZE + ' request.';

    const summary = counts + '. ' + verdict;
    ui.burstSummary.replaceChildren(el('span', { text: summary }));
    if (stoppedOnAuth) ui.burstSummary.append(actionButton('Nhập khoá API', 'key', () => openSheet('key')));
    announce(summary);

    state.burstRunning = false;
    ui.burstLabel.textContent = 'Gửi ' + BURST_SIZE + ' request liên tiếp';
    if (serverLooksDown) checkStatus();
    updateComposer();
    rescueFocus(ui.burst);
  }

  // --- connection sheet -----------------------------------------------------
  let sheetReturnFocus = null;
  let backdropPointerDown = false;

  function renderConnection() {
    const hasKey = Boolean(state.apiKey);
    ui.connectButton.dataset.key = hasKey ? 'set' : 'missing';
    ui.connectUser.textContent = state.userId;
    const label = hasKey
      ? 'Kết nối: đã có khoá API, người dùng ' + state.userId
      : 'Kết nối: chưa có khoá API, người dùng ' + state.userId;
    ui.connectButton.setAttribute('aria-label', label);
    ui.connectButton.title = label;
  }

  function showFieldError(input, errorNode, message) {
    errorNode.textContent = message;
    errorNode.hidden = !message;
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function setKeyVisible(visible) {
    ui.keyInput.type = visible ? 'text' : 'password';
    ui.keyToggle.setAttribute('aria-pressed', String(visible));
    ui.keyToggle.title = visible ? 'Ẩn khoá' : 'Hiện khoá';
    ui.keyToggleIcon.setAttribute('href', visible ? '#i-eye-off' : '#i-eye');
  }

  function openSheet(focusField) {
    setPopoverOpen(false);
    ui.keyInput.value = state.apiKey;
    ui.userInput.value = state.userId;
    setKeyVisible(false);
    showFieldError(ui.keyInput, ui.keyError, '');
    showFieldError(ui.userInput, ui.userError, '');
    ui.sheetStatus.textContent = '';

    if (!ui.sheet.open) {
      const active = document.activeElement;
      sheetReturnFocus = active && active !== document.body ? active : null;
      if (typeof ui.sheet.showModal === 'function') ui.sheet.showModal();
      else ui.sheet.setAttribute('open', '');
    }
    (focusField === 'user' ? ui.userInput : ui.keyInput).focus();
  }

  function onSheetClosed() {
    // Do not leave the key sitting in the DOM once the sheet is closed.
    ui.keyInput.value = '';
    setKeyVisible(false);
    const target = sheetReturnFocus && document.contains(sheetReturnFocus) ? sheetReturnFocus : null;
    sheetReturnFocus = null;
    if (target) target.focus();
    else focusComposer();
  }

  function closeSheet() {
    if (typeof ui.sheet.close === 'function') {
      if (ui.sheet.open) ui.sheet.close();
    } else {
      ui.sheet.removeAttribute('open');
      onSheetClosed();
    }
  }

  function saveApiKey(key) {
    state.apiKey = key;
    writeSlot(sessionArea, API_KEY_SLOT, key);
  }

  function saveUserId(userId) {
    state.userId = userId;
    writeSlot(localArea, USER_ID_SLOT, userId);
  }

  function onSheetSubmit(event) {
    event.preventDefault();
    const key = ui.keyInput.value.trim();
    const userId = ui.userInput.value.trim() || randomUserId();

    const keyProblem = key && !API_KEY_PATTERN.test(key)
      ? 'Khoá chỉ gồm chữ không dấu, số và ký hiệu, không có dấu cách.'
      : '';
    const userProblem = USER_ID_PATTERN.test(userId)
      ? ''
      : 'Chỉ dùng chữ không dấu, số và các ký tự . _ - (tối đa 40 ký tự).';

    showFieldError(ui.keyInput, ui.keyError, keyProblem);
    showFieldError(ui.userInput, ui.userError, userProblem);
    if (keyProblem) { ui.keyInput.focus(); return; }
    if (userProblem) { ui.userInput.focus(); return; }

    const previousUser = state.userId;
    saveApiKey(key);
    saveUserId(userId);
    renderConnection();
    closeSheet();

    if (previousUser !== userId && ui.messages.childElementCount > 0) {
      appendMessage(systemNote('Đã chuyển sang người dùng ' + userId + '. Lịch sử, hạn mức và ngân sách trên máy chủ được tính riêng cho mã này.'), true);
    }
  }

  // --- wiring ---------------------------------------------------------------
  function bindEvents() {
    ui.composer.addEventListener('submit', (event) => {
      event.preventDefault();
      submitComposer();
    });

    ui.input.addEventListener('keydown', (event) => {
      // keyCode 229 = an IME (e.g. Vietnamese Telex) is still composing.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        submitComposer();
      }
    });

    ui.input.addEventListener('input', () => {
      autosize();
      updateComposer();
    });

    document.querySelectorAll('.suggestion').forEach((button) => {
      button.addEventListener('click', () => askQuestion(button.dataset.question || button.textContent.trim(), null));
    });

    ui.statusButton.addEventListener('click', () => setPopoverOpen(ui.statusPopover.hidden));
    ui.statusRefresh.addEventListener('click', () => checkStatus());

    document.addEventListener('pointerdown', (event) => {
      if (ui.statusPopover.hidden) return;
      if (ui.statusPopover.contains(event.target) || ui.statusButton.contains(event.target)) return;
      setPopoverOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !ui.statusPopover.hidden) {
        setPopoverOpen(false);
        ui.statusButton.focus();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && status.waitingForVisibility) {
        status.waitingForVisibility = false;
        checkStatus();
      }
    });

    ui.connectButton.addEventListener('click', () => openSheet('key'));
    ui.sheetClose.addEventListener('click', closeSheet);
    ui.sheet.addEventListener('close', onSheetClosed);
    ui.sheetForm.addEventListener('submit', onSheetSubmit);

    // Close on a backdrop click, but not when a text selection drag inside
    // the sheet happens to be released over the backdrop.
    ui.sheet.addEventListener('pointerdown', (event) => { backdropPointerDown = event.target === ui.sheet; });
    ui.sheet.addEventListener('click', (event) => {
      if (event.target === ui.sheet && backdropPointerDown) closeSheet();
      backdropPointerDown = false;
    });

    ui.keyToggle.addEventListener('click', () => {
      setKeyVisible(ui.keyInput.type === 'password');
      ui.keyInput.focus();
    });

    ui.forgetKey.addEventListener('click', () => {
      saveApiKey('');
      ui.keyInput.value = '';
      showFieldError(ui.keyInput, ui.keyError, '');
      renderConnection();
      ui.sheetStatus.textContent = 'Đã xoá khoá khỏi tab này.';
      ui.keyInput.focus();
    });

    ui.userNew.addEventListener('click', () => {
      ui.userInput.value = randomUserId();
      showFieldError(ui.userInput, ui.userError, '');
      ui.userInput.focus();
    });

    ui.toolsToggle.addEventListener('click', () => {
      const open = ui.toolsToggle.getAttribute('aria-expanded') !== 'true';
      ui.toolsToggle.setAttribute('aria-expanded', String(open));
      ui.tools.hidden = !open;
    });

    ui.burst.addEventListener('click', runBurst);
    ui.clear.addEventListener('click', clearScreen);
  }

  function init() {
    const storedKey = readSlot(sessionArea, API_KEY_SLOT).trim();
    state.apiKey = API_KEY_PATTERN.test(storedKey) ? storedKey : '';

    let storedUser = readSlot(localArea, USER_ID_SLOT).trim();
    if (!USER_ID_PATTERN.test(storedUser)) {
      storedUser = randomUserId();
      writeSlot(localArea, USER_ID_SLOT, storedUser);
    }
    state.userId = storedUser;

    ui.storageNote.hidden = Boolean(sessionArea && localArea);
    renderConnection();
    renderStatus('checking');
    bindEvents();
    keepPinnedOnResize();
    autosize();
    updateComposer();
    checkStatus();

    if (!state.apiKey) openSheet('key');
    else focusComposer();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
