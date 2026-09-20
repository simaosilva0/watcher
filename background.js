// Background service worker.
// cp.pt's CSP blocks requests to ntfy from the content script, so they go from here.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'ntfy') return;

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
});
