// CP Train Watcher - content script
//
// results -> Selecionar ida -> Comprar -> accept terms -> Avançar para compra,
// then check what /sale returned. 500 ("sem lugar") = train full, go back and
// try again. 2xx = seat held, send the notification. Never touches payment.
//
// Retries use "Voltar aos resultados" instead of reloading the search URL
// (one XHR vs ~229 kB).

(() => {
  'use strict';

  // CONFIG
  const CONFIG = {
    // pacing
    // delay between attempts comes from the panel, clamped to this range,
    // plus random jitter (4s -> 4-8s)
    minDelaySec: 4,
    maxDelaySec: 300,
    jitter: 1.0, // up to +100%
    // max run length in minutes
    maxRunMinutes: 300,
    hardReloadEvery: 25, // full reload every N soft retries, to refresh the token

    // backoff
    backoffFactor: 2,
    maxBackoffMs: 300_000,
    // on an empty results page the backoff doesn't go past this level
    maxEmptyBackoffLevel: 2,

    // watchdogs
    // reload the search if nothing happens for this long
    stallMs: 120_000,
    // reload if the "Por favor aguarde" spinner is stuck for this long
    loaderMaxMs: 20_000,
    heartbeatMs: 20_000,

    // timeouts
    resultsTimeoutMs: 15_000,
    stepTimeoutMs: 12_000,
    // /sale can take a while when cp.pt is busy
    saleTimeoutMs: 90_000,

    // behaviour
    // ticks "Li e aceito as Condições de venda" automatically, false = do it yourself
    acceptTerms: true,
    // press "Avançar para compra" automatically
    autoAdvanceToPayment: true,
  };

  // Settings (localStorage)
  const SETTINGS_KEY = 'cp_watch_settings';
  const settings = {
    searchUrl: '', // the results page to reset to
    date: '', // YYYY-MM-DD, overrides the URL's startDate
    targetTime: '', // HH:MM departures, comma-separated, in priority order
    ntfyTopic: '',
    ntfyToken: '', // optional, for protected topics
    startAt: '', // optional HH:MM to hold off until
    delaySec: '4', // gap between attempts
    runMinutes: '60', // stop after this long
    collapsed: false,
    pos: null, // { left, top } after the panel is dragged
  };
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  } catch (_) {}
  // old versions had a password field that chrome autofilled, clear junk values
  if (settings.ntfyToken && !/^tk_\w+$/.test(settings.ntfyToken)) settings.ntfyToken = '';
  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

  // saved search url with startDate set to the chosen date
  function searchUrl() {
    const u = new URL(settings.searchUrl);
    if (settings.date && u.searchParams.has('startDate')) u.searchParams.set('startDate', settings.date);
    return u.href;
  }

  // "8:15, 19:39" -> ['08:15', '19:39'], null if something is invalid
  function parseTimes(str) {
    const out = [];
    for (const part of String(str || '').split(/[,;\s]+/).filter(Boolean)) {
      const m = /^([01]?\d|2[0-3])[:h.]?([0-5]\d)$/.exec(part);
      if (!m) return null;
      const t = `${m[1].padStart(2, '0')}:${m[2]}`;
      if (!out.includes(t)) out.push(t);
    }
    return out;
  }
  const targets = () => parseTimes(settings.targetTime) || [];

  const onTargetPage = () =>
    /resultado-pesquisa/.test(location.pathname) &&
    new URL(location.href).searchParams.get('startDate') === settings.date;

  // Run state (sessionStorage, per tab)
  const K = {
    active: 'cp_watch_active',
    attempts: 'cp_watch_attempts',
    done: 'cp_watch_done',
    phase: 'cp_watch_phase',
    soft: 'cp_watch_soft',
    backoff: 'cp_watch_backoff',
    endsAt: 'cp_watch_ends_at',
    round: 'cp_watch_round', // departures not yet tried in this pass
    current: 'cp_watch_current', // departure being booked right now
    sale: 'cp_watch_sale', // last /sale result, kept across navigations
    offPage: 'cp_watch_off_page', // consecutive loads that landed off the results page
    startsAt: 'cp_watch_starts_at', // "Start at" as a timestamp, so a reload keeps waiting
  };

  // a round = one pass over all the departure times
  const roundLeft = () => {
    try {
      return JSON.parse(sessionStorage.getItem(K.round) || '[]');
    } catch (_) {
      return [];
    }
  };
  const setRound = (list) => sessionStorage.setItem(K.round, JSON.stringify(list));
  const current = () => sessionStorage.getItem(K.current) || settings.targetTime;

  const isActive = () => sessionStorage.getItem(K.active) === 'true';
  const isDone = () => sessionStorage.getItem(K.done) === 'true';
  const attempts = () => parseInt(sessionStorage.getItem(K.attempts) || '0', 10);
  const backoffLevel = () => parseInt(sessionStorage.getItem(K.backoff) || '0', 10);
  const bumpBackoff = () => sessionStorage.setItem(K.backoff, String(Math.min(backoffLevel() + 1, 12)));
  const clearBackoff = () => sessionStorage.setItem(K.backoff, '0');

  let countdownTimer = null;
  let retryTimer = null;
  let startTimer = null;
  let busy = false;
  let lastSale = null; // { ok, status, at } from inject.js
  let lastProgress = Date.now();
  let nextActionAt = 0; // next scheduled retry/start

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__cpWatchSale !== true) return;
    lastSale = { ok: d.ok, status: d.status, at: Date.now() };
    // keep it in case the page navigates away
    sessionStorage.setItem(K.sale, JSON.stringify(lastSale));
    console.log('[cp-watch] /sale responded', d.status, d.ok ? '-> seat secured' : '-> no seat');
  });

  // Notifications
  async function notify(title, message, { priority = 'high', tags = 'steam_locomotive' } = {}) {
    if (!settings.ntfyTopic) {
      setStatus('ntfy topic not set - no notification sent.');
      return false;
    }
    try {
      const reply = await chrome.runtime.sendMessage({
        type: 'ntfy',
        token: settings.ntfyToken,
        payload: {
          topic: settings.ntfyTopic,
          title,
          message,
          priority: priority === 'high' ? 5 : 3,
          tags: [tags],
          click: location.href,
        },
      });
      if (reply && reply.ok) return true;
      const why = !reply ? 'no reply' : reply.status === 401 || reply.status === 403
        ? 'ntfy rejected the token - check it or clear the field'
        : reply.error || `HTTP ${reply.status}`;
      setStatus(`Notification failed: ${why}`);
    } catch (err) {
      // extension got reloaded while this tab was open
      setStatus('Notification failed: extension was reloaded - refresh this page.');
      console.warn('[cp-watch] background worker unreachable:', err);
    }
    return false;
  }

  // DOM helpers
  function waitFor(fn, timeoutMs, interval = 100) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        let v = null;
        try {
          v = fn();
        } catch (_) {}
        if (v) return resolve(v);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  const visible = (el) => !!el && el.offsetParent !== null;
  const enabled = (el) =>
    !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !/disabled/i.test(el.className);
  const byText = (root, selector, re) =>
    [...root.querySelectorAll(selector)].find((el) => re.test((el.textContent || '').trim()));

  const resultCount = () => document.querySelectorAll('li[class*="result-item"]').length;

  // the trip row
  const TIME_IN_LABEL = /partida\s*[àa]s\s*(\d{1,2}:\d{2})/i;

  function findItem(time) {
    for (const li of document.querySelectorAll('li[class*="result-item"]')) {
      const m = (li.getAttribute('aria-label') || '').match(TIME_IN_LABEL);
      if (m && m[1].padStart(5, '0') === time) return li;
    }
    return null;
  }

  const isSelected = (li) =>
    /item-selected/.test(li.className) || /viagem\s+selecionada/i.test(li.getAttribute('aria-label') || '');

  function selectButton(li) {
    const btn = byText(li, 'button.cta-button, button', /selecionar\s+ida/i) || li.querySelector('button.cta-button');
    return visible(btn) && enabled(btn) ? btn : null;
  }

  const isSoldOut = (li) => /esgotad|indispon[ií]vel|sem lugares|lotado|sold\s?out/i.test(li.innerText || '');

  // checkout controls
  function buyNavButton() {
    const bar = document.querySelector('#buyTripNavBar');
    if (!bar) return null;
    const btn =
      bar.querySelector('button[class*="footer__content__cta-button"]') || byText(bar, 'button', /^comprar$/i);
    return visible(btn) && enabled(btn) ? btn : null;
  }

  function confirmModal() {
    const modal =
      document.querySelector('div[role="dialog"] .modal-container') ||
      document.querySelector('.modalViagemSelecionada');
    return visible(modal) ? modal : null;
  }

  const termsCheckbox = (modal) =>
    modal.querySelector('.confirm-section input[type="checkbox"], input[id^="checkbox-"]');

  function advanceButton(modal) {
    const btn =
      byText(modal, 'button.confirm-button, button', /avan[çc]ar\s+para\s+compra/i) ||
      modal.querySelector('button.confirm-button');
    return visible(btn) && enabled(btn) ? btn : null;
  }

  async function tickTerms(modal) {
    const input = termsCheckbox(modal);
    if (!input) return false;
    if (input.checked) return true;
    const span = modal.querySelector('.confirm-section .custom-checkbox');
    for (const target of [span, input.closest('label'), input]) {
      if (!target) continue;
      target.click();
      await new Promise((r) => setTimeout(r, 120));
      if (input.checked) return true;
    }
    return false;
  }

  // page-state detection
  function saleFailedPage() {
    if (document.querySelector('[src*="sem-lugar"], img[src*="Error/"]')) return true;
    const t = document.body ? document.body.innerText || '' : '';
    return (
      /tente novamente/i.test(t) && /voltar aos resultados|refazer pesquisa/i.test(t)
    );
  }

  const salePassedPage = () => /pagamento|payment|checkout|compra\/|mb-?way|multibanco/i.test(location.href);

  function looksBlocked() {
    if (resultCount() > 0) return false;
    const txt = (document.body ? document.body.innerText || '' : '').slice(0, 4000);
    if (/429|too many requests|rate limit|acesso bloqueado|tente novamente mais tarde/i.test(txt)) return true;
    if (/captcha|verifique que (é|e) humano|are you human/i.test(txt)) return true;
    return !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], #challenge-form');
  }

  // One attempt
  async function runAttempt() {
    if (busy || isDone() || !isActive()) return;
    busy = true;

    try {
      const n = attempts() + 1;
      sessionStorage.setItem(K.attempts, String(n));
      setStatus(`Attempt ${n} - checking...`);

      if (Date.now() > Number(sessionStorage.getItem(K.endsAt) || Infinity)) {
        stop();
        setStatus(`Gave up after ${settings.runMinutes} min (${n - 1} attempts).`);
        await notify('CP watcher stopped', `No seat after ${settings.runMinutes} min (${n - 1} attempts).`, {
          priority: 'default',
          tags: 'warning',
        });
        return;
      }

      // 1. find the trips
      const times = targets();
      const listed = await waitFor(() => times.some(findItem) || null, CONFIG.resultsTimeoutMs);
      if (!listed) {
        setRound([]); // start the next round from the top
        if (!/resultado-pesquisa/.test(location.pathname)) {
          // got sent somewhere else (home page etc)
          setStatus(`Attempt ${n} - off the results page, going back...`);
          return recoverOffPage();
        }
        if (looksBlocked()) {
          bumpBackoff();
          setStatus(`Attempt ${n} - blocked or throttled.`);
          if (backoffLevel() === 3) {
            notify('CP watcher throttled', 'cp.pt stopped returning results. Slowing down.', {
              priority: 'default',
              tags: 'warning',
            });
          }
        } else if (resultCount() === 0) {
          // cp.pt sometimes says "Não foram encontrados resultados" for trains that exist
          if (backoffLevel() < CONFIG.maxEmptyBackoffLevel) bumpBackoff();
          setStatus(`Attempt ${n} - cp.pt returned an empty list, reloading.`);
        } else {
          clearBackoff();
          setStatus(`Attempt ${n} - ${times.join(', ')} not listed.`);
        }
        return scheduleRetry();
      }

      clearBackoff();
      sessionStorage.removeItem(K.offPage);

      // next time in this round that is listed and not sold out
      let round = roundLeft().filter((t) => times.includes(t));
      if (round.length === 0) round = [...times];
      let time = null;
      let li = null;
      const skipped = [];
      while (round.length && !li) {
        const t = round.shift();
        const item = findItem(t);
        if (item && !isSoldOut(item)) {
          time = t;
          li = item;
        } else {
          skipped.push(t);
        }
      }
      setRound(round);

      if (!li) {
        setStatus(`Attempt ${n} - ${skipped.join(', ')} sold out or not listed.`);
        return scheduleRetry();
      }
      sessionStorage.setItem(K.current, time);
      setStatus(`Attempt ${n} - trying ${time}...`);

      li.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // 2. Selecionar ida
      if (!isSelected(li)) {
        const sel = await waitFor(() => selectButton(li), CONFIG.stepTimeoutMs);
        if (!sel) {
          setStatus(`Attempt ${n} - no "Selecionar ida" button.`);
          return scheduleRetry();
        }
        sel.click();
        if (!(await waitFor(() => isSelected(li) || null, CONFIG.stepTimeoutMs))) {
          setStatus(`Attempt ${n} - selection didn't stick.`);
          return scheduleRetry();
        }
      }

      // in checkout, stop the timers but keep the run active so it picks up
      // again if cp.pt redirects somewhere else
      pauseTimers();
      setStatus(`Selected ${time} - opening purchase...`);

      // 3. Comprar
      const buy = await waitFor(buyNavButton, CONFIG.stepTimeoutMs);
      if (!buy) return resumeAfterFailure('Selected the train but "Comprar" never appeared.');
      buy.click();

      // 4. modal + terms
      const modal = await waitFor(confirmModal, CONFIG.stepTimeoutMs);
      if (!modal) return resumeAfterFailure('Clicked "Comprar" but the modal never opened.');
      setStatus('Confirming...');

      if (CONFIG.acceptTerms && !(await tickTerms(modal))) {
        return resumeAfterFailure('Could not tick the terms box.');
      }

      if (!CONFIG.autoAdvanceToPayment) {
        sessionStorage.setItem(K.done, 'true');
        stop();
        setStatus('Ready - press "Avançar para compra".');
        return notify('CP watcher paused', 'Modal is ready. Press "Avançar para compra".', {
          priority: 'high',
          tags: 'warning',
        });
      }

      const adv = await waitFor(() => advanceButton(modal), CONFIG.stepTimeoutMs);
      if (!adv) return resumeAfterFailure('"Avançar para compra" stayed disabled.');

      // 5. submit and read the verdict
      setStatus('Submitting sale...');
      sessionStorage.setItem(K.phase, 'sale');
      heartbeat(); // background leaves the tab alone during the sale
      lastSale = null;
      sessionStorage.removeItem(K.sale);
      adv.click();

      const verdict = await waitFor(() => {
        if (lastSale && Date.now() - lastSale.at < 90_000) return lastSale.ok ? 'ok' : 'fail';
        if (saleFailedPage()) return 'fail';
        if (salePassedPage()) return 'ok';
        return null;
      }, CONFIG.saleTimeoutMs);

      return settleSale(verdict);
    } finally {
      busy = false;
    }
  }

  async function settleSale(verdict) {
    sessionStorage.removeItem(K.phase);

    if (verdict === 'ok') {
      sessionStorage.setItem(K.done, 'true');
      stop();
      setStatus(`Seat secured on the ${current()} - go pay.`);
      await notify(
        'CP seat secured',
        `The ${current()} train on ${settings.date} is held in checkout. Pay now, it expires.`,
        { priority: 'high' }
      );
      return;
    }

    if (verdict === 'fail') {
      setStatus(`Attempt ${attempts()} - no seat on the ${current()} (sale rejected).`);
      return resumeSilently();
    }

    // no 2xx from /sale and not on checkout, nothing was booked. keep going
    console.log('[cp-watch] no sale verdict:', location.pathname, lastSale ? lastSale.status : '/sale not seen');
    setStatus(`Attempt ${attempts()} - no answer from cp.pt for the ${current()}, retrying.`);
    resumeSilently();
  }

  // not on the results page anymore, go back (waits longer each time)
  function recoverOffPage() {
    pauseTimers();
    const n = parseInt(sessionStorage.getItem(K.offPage) || '0', 10) + 1;
    sessionStorage.setItem(K.offPage, String(n));
    if (n === 6) {
      notify('CP watcher bounced', 'cp.pt keeps sending the watcher away from the results. Still retrying.', {
        priority: 'default',
        tags: 'warning',
      });
    }
    const delay = Math.min(1000 * Math.pow(2, n - 1), CONFIG.maxBackoffMs) * (1 + Math.random() * 0.5);
    setSub(`Back to results in ${Math.round(delay / 1000)}s`);
    nextActionAt = Date.now() + delay;
    retryTimer = setTimeout(() => {
      if (!isActive() || isDone()) return;
      sessionStorage.setItem(K.soft, '0');
      location.href = searchUrl();
    }, delay);
  }

  function resumeSilently() {
    sessionStorage.removeItem(K.phase);
    sessionStorage.removeItem(K.done);
    sessionStorage.setItem(K.active, 'true');
    paintButton();
    scheduleRetry();
  }

  function resumeAfterFailure(reason) {
    setStatus(`${reason} Retrying.`);
    resumeSilently();
  }

  // Retry scheduling
  // back to the results without a full reload
  function softRetry() {
    if (loaderVisible()) return false; // stuck, needs a full reload
    const back =
      byText(document, 'button, a', /voltar aos resultados/i) ||
      byText(document, 'button, a', /refazer pesquisa/i);

    if (back && visible(back)) {
      setStatus('Back to results...');
      back.click();
      setTimeout(runAttempt, 400);
      return true;
    }
    if (resultCount() > 0) {
      setTimeout(runAttempt, 300);
      return true;
    }
    return false;
  }

  function scheduleRetry() {
    if (!isActive() || isDone()) return;

    const nextTrip = roundLeft().length > 0;
    const base = Number(settings.delaySec) * 1000 * (1 + Math.random() * CONFIG.jitter);
    const level = backoffLevel();
    const delay = Math.min(base * Math.pow(CONFIG.backoffFactor, level), CONFIG.maxBackoffMs);
    const readyAt = Date.now() + delay;
    nextActionAt = readyAt;

    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      const left = Math.max(0, Math.round((readyAt - Date.now()) / 1000));
      setSub(
        level > 0
          ? `Backing off - ${left}s`
          : nextTrip
          ? `Next: ${roundLeft()[0]} in ${left}s`
          : `Retrying in ${left}s`
      );
      if (left === 0) clearInterval(countdownTimer);
    }, 1000);

    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (!isActive() || isDone()) return;
      const soft = parseInt(sessionStorage.getItem(K.soft) || '0', 10);
      if (soft < CONFIG.hardReloadEvery && softRetry()) {
        sessionStorage.setItem(K.soft, String(soft + 1));
        return;
      }
      sessionStorage.setItem(K.soft, '0');
      location.href = searchUrl(); // full reload refreshes the session token
    }, delay);
  }

  // Start / stop
  function msUntilStartAt() {
    if (!settings.startAt) return 0;
    const m = /^(\d{1,2}):(\d{2})$/.exec(settings.startAt.trim());
    if (!m) return 0;
    const t = new Date();
    t.setHours(+m[1], +m[2], 0, 0);
    const diff = t.getTime() - Date.now();
    return diff > 0 ? diff : 0; // already passed, start now
  }

  function missingSetting() {
    if (!settings.searchUrl) return 'start page';
    if (!settings.date) return 'train date';
    if (targets().length === 0) return 'departure time';
    if (!settings.ntfyTopic) return 'ntfy topic';
    return null;
  }

  // make sure we're on the results page for the right date
  function go() {
    if (!isActive()) return;
    if (!onTargetPage()) {
      setStatus('Opening the results page...');
      location.href = searchUrl(); // boot resumes the run there
      return;
    }
    runAttempt();
  }

  function start() {
    const missing = missingSetting();
    if (missing) return setStatus(`Set the ${missing} first.`);

    sessionStorage.removeItem(K.done);
    sessionStorage.removeItem(K.phase);
    sessionStorage.removeItem(K.soft);
    sessionStorage.removeItem(K.round);
    sessionStorage.removeItem(K.current);
    sessionStorage.removeItem(K.sale);
    sessionStorage.removeItem(K.offPage);
    clearBackoff();
    sessionStorage.setItem(K.active, 'true');
    paintButton();

    const wait = msUntilStartAt();
    sessionStorage.setItem(K.endsAt, String(Date.now() + wait + Number(settings.runMinutes) * 60_000));
    sessionStorage.setItem(K.startsAt, String(Date.now() + wait));
    waitThenGo();
  }

  function waitThenGo() {
    const readyAt = Number(sessionStorage.getItem(K.startsAt) || 0);
    const wait = readyAt - Date.now();
    if (wait > 0) {
      nextActionAt = readyAt;
      setStatus(`Waiting until ${settings.startAt}...`);
      clearInterval(countdownTimer);
      countdownTimer = setInterval(() => {
        const left = Math.max(0, Math.round((readyAt - Date.now()) / 1000));
        const mm = Math.floor(left / 60);
        setSub(mm > 0 ? `Starts in ${mm}m ${left % 60}s` : `Starts in ${left}s`);
        if (left === 0) clearInterval(countdownTimer);
      }, 1000);
      clearTimeout(startTimer);
      startTimer = setTimeout(go, wait);
      return;
    }
    go();
  }

  function pauseTimers() {
    clearTimeout(retryTimer);
    clearTimeout(startTimer);
    clearInterval(countdownTimer);
    setSub('');
  }

  function stop() {
    sessionStorage.setItem(K.active, 'false');
    pauseTimers();
    paintButton();
    heartbeat();
  }

  // Watchdogs
  // ok to send the tab back to the search? never on checkout
  const recoverable = () =>
    isActive() && !isDone() && sessionStorage.getItem(K.phase) !== 'sale' && !salePassedPage();

  // lets the background reload the tab if this page dies
  function heartbeat() {
    let msg = { type: 'unwatch' };
    try {
      if (recoverable()) msg = { type: 'watch', url: searchUrl(), staleMs: CONFIG.stallMs };
    } catch (_) {}
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (_) {} // extension reloaded while the tab stayed open
  }

  // cp.pt full page spinner
  const loaderVisible = () =>
    /por favor aguarde um momento|please wait a moment/i.test(
      (document.body ? document.body.innerText || '' : '').slice(0, 3000)
    );

  let loaderSince = 0;
  function loaderWatch() {
    if (!loaderVisible()) return (loaderSince = 0);
    if (!loaderSince) loaderSince = Date.now();
    if (!recoverable() || Date.now() - loaderSince < CONFIG.loaderMaxMs) return;
    loaderSince = 0;
    setStatus('cp.pt stuck on "Por favor aguarde" - reloading the search.');
    sessionStorage.setItem(K.soft, '0');
    location.href = searchUrl();
  }

  // page is alive but nothing is happening
  function watchdog() {
    if (!recoverable()) return;
    const quietSince = Math.max(lastProgress, nextActionAt);
    if (Date.now() - quietSince < CONFIG.stallMs) return;
    setStatus('Watcher stalled - reloading the search.');
    sessionStorage.setItem(K.soft, '0');
    location.href = searchUrl();
  }

  function reset() {
    stop();
    for (const k of [K.attempts, K.done, K.phase, K.soft, K.round, K.current, K.sale, K.offPage]) {
      sessionStorage.removeItem(k);
    }
    clearBackoff();
    setStatus('Idle.');
  }

  // Panel
  let toggleBtn, statusEl, subEl, titleEl, pageEl;
  const inputs = [];

  function setStatus(msg) {
    lastProgress = Date.now();
    if (statusEl) statusEl.textContent = msg;
    console.log('[cp-watch]', msg);
  }
  function setSub(msg) {
    if (subEl) subEl.textContent = msg;
  }
  function paintButton() {
    if (!toggleBtn) return;
    const on = isActive();
    toggleBtn.textContent = on ? 'Stop watching' : 'Start watching';
    toggleBtn.style.backgroundColor = on ? '#dc3545' : '#28a745';
    for (const el of inputs) el.disabled = on; // no settings changes mid-run
  }
  function paintSettings() {
    if (titleEl) titleEl.textContent = `CP watcher v${chrome.runtime.getManifest().version} - ${settings.date || '-'} ${settings.targetTime || ''}`;
    if (pageEl) {
      pageEl.textContent = settings.searchUrl ? 'Start page set' : 'No start page yet';
      pageEl.title = settings.searchUrl;
    }
  }

  const BTN_CSS =
    'padding:6px;border:1px solid #3b4252;border-radius:5px;background:transparent;color:#c9ccd4;cursor:pointer;font-size:12px;';
  const INPUT_CSS =
    'flex:1;min-width:0;padding:4px 6px;border:1px solid #3b4252;border-radius:4px;background:#2a3040;color:#f5f6f8;font-size:12px;color-scheme:dark;';

  function mkButton(text, onclick, extra = '') {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = BTN_CSS + extra;
    b.onclick = onclick;
    return b;
  }

  // label + input bound to settings[key]
  function mkField(label, key, type, extraEl, { min, max } = {}) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:12px;';
    const span = document.createElement('span');
    span.textContent = label;
    span.style.cssText = 'width:62px;flex:none;opacity:.75;';
    const input = document.createElement('input');
    // type=time shows AM/PM on some locales, so times are text fields
    input.type = type === 'hhmm' || type === 'hhmmList' ? 'text' : type;
    if (type === 'hhmm') {
      input.placeholder = 'HH:MM';
      input.maxLength = 5;
    }
    if (type === 'hhmmList') input.placeholder = 'HH:MM, HH:MM...';
    input.autocomplete = 'off';
    input.value = settings[key];
    input.style.cssText = INPUT_CSS;
    if (min != null) input.min = min;
    if (max != null) input.max = max;
    input.onchange = () => {
      if (type === 'number') {
        const v = Math.round(Number(input.value)) || Number(min);
        input.value = Math.min(Math.max(v, min ?? -Infinity), max ?? Infinity);
      }
      if (type === 'hhmm' && input.value.trim()) {
        const m = /^([01]?\d|2[0-3])[:h.]?([0-5]\d)$/.exec(input.value.trim());
        if (!m) {
          input.value = settings[key];
          return setStatus(`${label}: use 24h HH:MM, e.g. 19:39.`);
        }
        input.value = `${m[1].padStart(2, '0')}:${m[2]}`;
      }
      if (type === 'hhmmList') {
        const list = parseTimes(input.value);
        if (!list) {
          input.value = settings[key];
          return setStatus(`${label}: 24h times separated by commas, e.g. 08:15, 19:39.`);
        }
        input.value = list.join(', ');
      }
      if (key === 'ntfyToken' && input.value.trim() && !/^tk_\w+$/.test(input.value.trim())) {
        input.value = settings[key];
        return setStatus('ntfy tokens start with "tk_". Leave empty if your topic is public.');
      }
      settings[key] = input.value.trim();
      saveSettings();
      paintSettings();
    };
    inputs.push(input);
    row.append(span, input);
    if (extraEl) row.append(extraEl);
    return { row, input };
  }

  function injectPanel() {
    if (document.getElementById('cp-watch-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'cp-watch-panel';
    panel.style.cssText = `
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      width: 280px; padding: 14px; box-sizing: border-box;
      background: #1f2430; color: #f5f6f8;
      font: 13px/1.45 system-ui, -apple-system, sans-serif;
      border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.35);
    `;

    // header: drag to move, click to collapse
    titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-weight:700;margin-bottom:8px;cursor:move;user-select:none;touch-action:none;';
    titleEl.title = 'Drag to move - click to show / hide settings';

    const body = document.createElement('div');
    const paintCollapsed = () => (body.style.display = settings.collapsed ? 'none' : '');

    // keep it on screen
    const place = ({ left, top }) => {
      left = Math.min(Math.max(0, left), window.innerWidth - panel.offsetWidth);
      top = Math.min(Math.max(0, top), window.innerHeight - 40);
      Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, right: 'auto' });
      return { left, top };
    };

    let drag = null;
    titleEl.onpointerdown = (e) => {
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x: e.clientX, y: e.clientY, moved: false };
      titleEl.setPointerCapture(e.pointerId);
    };
    titleEl.onpointermove = (e) => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
      if (drag.moved) place({ left: e.clientX - drag.dx, top: e.clientY - drag.dy });
    };
    titleEl.onpointerup = () => {
      if (!drag) return;
      if (drag.moved) {
        const r = panel.getBoundingClientRect();
        settings.pos = { left: r.left, top: r.top };
      } else {
        settings.collapsed = !settings.collapsed; // plain click
        paintCollapsed();
      }
      saveSettings();
      drag = null;
    };

    // start page
    const pageRow = document.createElement('div');
    pageRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:12px;';
    pageEl = document.createElement('span');
    pageEl.style.cssText = 'flex:1;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    const useBtn = mkButton('Use this page', () => {
      if (!/resultado-pesquisa/.test(location.pathname)) {
        return setStatus('Open a cp.pt search results page first.');
      }
      settings.searchUrl = location.href;
      const d = new URL(location.href).searchParams.get('startDate');
      if (d) settings.date = dateField.input.value = d;
      saveSettings();
      paintSettings();
      setStatus('Start page saved.');
    });
    inputs.push(useBtn);
    pageRow.append(pageEl, useBtn);

    const dateField = mkField('Date', 'date', 'date');
    const timeField = mkField('Departs', 'targetTime', 'hhmmList');
    timeField.input.title = 'One or more departures, in order of preference. Stops at the first seat secured.';

    const genBtn = mkButton('New', () => {
      const hex = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');
      settings.ntfyTopic = topicField.input.value = `cp-watch-${hex}`;
      saveSettings();
      setStatus(`Subscribe to "${settings.ntfyTopic}" in the ntfy app.`);
    });
    genBtn.title = 'Generate a random, hard-to-guess topic';
    inputs.push(genBtn);
    const topicField = mkField('ntfy topic', 'ntfyTopic', 'text', genBtn);

    // not type=password, chrome autofills the cp.pt password into those
    const tokenField = mkField('ntfy token', 'ntfyToken', 'text');
    tokenField.input.placeholder = 'optional, tk_...';
    tokenField.input.style.webkitTextSecurity = 'disc';
    const startAtField = mkField('Start at', 'startAt', 'hhmm');
    startAtField.input.title = 'Optional: wait until this time before the first attempt';
    const delayField = mkField('Every (s)', 'delaySec', 'number', null, {
      min: CONFIG.minDelaySec,
      max: CONFIG.maxDelaySec,
    });
    delayField.input.title = `Seconds between attempts (min ${CONFIG.minDelaySec}), randomised up to x2`;
    const runField = mkField('Run (min)', 'runMinutes', 'number', null, { min: 1, max: CONFIG.maxRunMinutes });
    runField.input.title = `Stop after this many minutes (max ${CONFIG.maxRunMinutes})`;

    body.append(pageRow, dateField.row, timeField.row, topicField.row, tokenField.row, startAtField.row, delayField.row, runField.row);

    statusEl = document.createElement('div');
    statusEl.style.cssText = 'margin:4px 0;opacity:.9;';
    statusEl.textContent = 'Idle.';

    subEl = document.createElement('div');
    subEl.style.cssText = 'margin-bottom:10px;opacity:.6;font-size:12px;min-height:16px;';

    toggleBtn = document.createElement('button');
    toggleBtn.style.cssText =
      'width:100%;padding:10px;border:0;border-radius:5px;color:#fff;font-weight:700;cursor:pointer;font-size:13px;';
    toggleBtn.onclick = () => (isActive() ? stop() : start());

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
    row.append(
      mkButton('Test ntfy', async () => {
        if (await notify('CP watcher test', 'Notifications are working.', { priority: 'default' })) {
          setStatus(`Test sent to "${settings.ntfyTopic}".`);
        }
      }, 'flex:1;'),
      mkButton('Reset', reset, 'flex:1;')
    );

    panel.append(titleEl, body, statusEl, subEl, toggleBtn, row);
    document.body.appendChild(panel);
    paintCollapsed();
    if (settings.pos) place(settings.pos);
    window.addEventListener('resize', () => settings.pos && place(settings.pos));
    paintSettings();
    paintButton();
  }

  // Boot
  injectPanel();
  heartbeat();
  setInterval(loaderWatch, 2000);
  setInterval(() => {
    heartbeat();
    watchdog();
  }, CONFIG.heartbeatMs);

  if (sessionStorage.getItem(K.phase) === 'sale') {
    // page changed while waiting for the sale result
    setStatus('Checking sale result...');
    try {
      lastSale = lastSale || JSON.parse(sessionStorage.getItem(K.sale) || 'null');
    } catch (_) {}
    // landed on the home page, cp.pt dropped the purchase
    const onHome = /^\/(pt|en)?\/?$/i.test(location.pathname);
    waitFor(() => {
      if (lastSale) return lastSale.ok ? 'ok' : 'fail';
      if (saleFailedPage()) return 'fail';
      if (salePassedPage()) return 'ok';
      return null;
    }, onHome ? 500 : 10_000).then(settleSale);
  } else if (isActive() && !isDone()) {
    if (Number(sessionStorage.getItem(K.startsAt) || 0) > Date.now()) {
      waitThenGo(); // reloaded during the "Start at" wait
    } else if (salePassedPage()) {
      // don't touch checkout pages
      setStatus('On a checkout page - leaving it alone.');
    } else if (!onTargetPage()) {
      setStatus('Off the results page, going back...');
      recoverOffPage();
    } else {
      setStatus(`Resuming - attempt ${attempts() + 1}...`);
      setTimeout(runAttempt, 1000);
    }
  }
})();
