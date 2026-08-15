// M Lakhamsi — lightweight self-hosted analytics tracker.
// Fire-and-forget: never awaited, never throws back into the page. Managed
// alongside the dashboard at /admin-analytics.html.
(function () {
  'use strict';

  if (location.pathname.startsWith('/admin')) return; // never track admin usage

  var SID_KEY = 'ml_sid';
  function getSessionId() {
    try {
      var sid = localStorage.getItem(SID_KEY);
      if (!sid) {
        sid = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
        localStorage.setItem(SID_KEY, sid);
      }
      return sid;
    } catch (e) {
      // localStorage unavailable (private mode, etc.) — fall back to a
      // per-page-load id rather than breaking tracking entirely.
      return 'anon-' + Date.now();
    }
  }

  function deviceType() {
    var ua = navigator.userAgent || '';
    if (/iPad|Android(?!.*Mobile)|Tablet/i.test(ua)) return 'tablet';
    if (/Mobi|iPhone|Android/i.test(ua)) return 'mobile';
    return 'desktop';
  }

  var sessionId = getSessionId();
  var device = deviceType();

  function send(eventType, extra) {
    try {
      var payload = Object.assign({
        sessionId: sessionId,
        eventType: eventType,
        pagePath: location.pathname,
        referrer: document.referrer || '',
        deviceType: device
      }, extra || {});
      var body = JSON.stringify(payload);

      if (eventType === 'page_time' && navigator.sendBeacon) {
        navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true
      }).catch(function () {});
    } catch (e) {
      // analytics must never break the page
    }
  }

  // page_view — fires once per load (this is a static multi-page site, not
  // an SPA, so a plain load listener covers route changes automatically).
  send('page_view');

  // page_time — dwell time on this page, sent when the visitor navigates
  // away. pagehide is used instead of beforeunload for reliability across
  // mobile browsers and bfcache.
  var startTime = Date.now();
  window.addEventListener('pagehide', function () {
    var seconds = Math.round((Date.now() - startTime) / 1000);
    if (seconds > 0 && seconds < 3600) send('page_time', { value: seconds });
  });

  // whatsapp_click — delegated listener, catches the floating button and
  // any inline WhatsApp CTA (all use wa.me links).
  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('a[href*="wa.me"]');
    if (link) send('whatsapp_click');
  });

  window.mlTrack = send; // exposed so page-specific scripts (e.g. the inquiry form) can fire named events
})();
