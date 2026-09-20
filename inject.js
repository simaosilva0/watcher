// Runs in the PAGE's JS world (manifest sets world: "MAIN") so it can patch the
// page's own fetch/XHR. A normal content script gets an isolated `window` and
// would never see these calls.
//
// Single job: report the outcome of POST api-gateway.cp.pt/.../sale.
// That request is the only reliable availability signal on cp.pt - the results
// list renders "Selecionar ida" and a full price even for sold-out trains, and
// the journeys API returns occupancy: null whether or not seats exist.
//   2xx  -> seat secured
//   500  -> "sem lugar", train is full

(() => {
  'use strict';

  const isSale = (u) => {
    if (!u) return false;
    const s = String(u);
    return /\/sale(\?|$|\/)/i.test(s) || /api-gateway\.cp\.pt\/.*sale/i.test(s);
  };

  const report = (ok, status) => {
    try {
      window.postMessage({ __cpWatchSale: true, ok: !!ok, status: status | 0 }, '*');
    } catch (_) {}
  };

  // fetch
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (...args) {
      const input = args[0];
      const url = typeof input === 'string' ? input : input && input.url;
      const watched = isSale(url);
      try {
        const res = await origFetch.apply(this, args);
        if (watched) report(res.ok, res.status);
        return res;
      } catch (err) {
        if (watched) report(false, 0);
        throw err;
      }
    };
  }

  // XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__cpUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (isSale(this.__cpUrl)) {
      this.addEventListener('loadend', () => {
        report(this.status >= 200 && this.status < 300, this.status);
      });
    }
    return origSend.apply(this, args);
  };
})();
