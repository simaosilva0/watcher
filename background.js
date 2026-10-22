// Background service worker.
//
// - sends the ntfy notifications (cp.pt's CSP blocks them from the content script)
// - watchdog: the cp.pt tab pings every ~20s while running. If the pings stop
//   (error page, crashed/discarded tab, redirect off cp.pt) the tab gets sent
//   back to the search. No pings during a sale or on checkout.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'ntfy') {
    const headers = { 'Content-Type': 'application/json' };
    if (msg.token) headers.Authorization = `Bearer ${msg.token}`;

    fetch('https://ntfy.sh', {
      method: 'POST',
      headers,
      body: JSON.stringify(msg.payload),
    })
      .then((res) => sendResponse({ ok: res.ok, status: res.status }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));

    return true; // keep the channel open for the async response
  }

  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return;
  const key = `watch_${tabId}`;

  if (msg.type === 'watch') {
    chrome.storage.session.set({ [key]: { url: msg.url, staleMs: msg.staleMs || 120_000, at: Date.now() } });
    ensureAlarm();
  } else if (msg.type === 'unwatch') {
    chrome.storage.session.remove(key);
  }
});

const ALARM = 'cp-watchdog';

function ensureAlarm() {
  chrome.alarms.get(ALARM, (a) => {
    if (!a) chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  const all = await chrome.storage.session.get(null);
  const entries = Object.entries(all).filter(([k]) => k.startsWith('watch_'));
  if (entries.length === 0) return chrome.alarms.clear(ALARM);

  for (const [key, w] of entries) {
    const tabId = Number(key.slice('watch_'.length));
    try {
      await chrome.tabs.get(tabId);
    } catch (_) {
      await chrome.storage.session.remove(key); // tab closed
      continue;
    }
    if (Date.now() - w.at < w.staleMs) continue;

    console.log('[cp-watch] tab', tabId, 'went quiet - reloading the search');
    // give the reload time before trying again
    await chrome.storage.session.set({ [key]: { ...w, at: Date.now() } });
    chrome.tabs.update(tabId, { url: w.url }).catch(() => {});
  }
});
