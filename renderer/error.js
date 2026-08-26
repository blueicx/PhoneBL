'use strict';

(function () {
  const banner = document.getElementById('js-error-banner');
  if (!banner) return;
  const show = (prefix, detail) => {
    banner.style.display = 'block';
    banner.textContent += `${prefix}: ${detail}\n`;
    banner.title = '点击复制错误信息';
    banner.onclick = async () => {
      try { await navigator.clipboard.writeText(banner.textContent); } catch {}
    };
  };
  window.addEventListener('error', event => show('ERROR', `${event.message} @ ${event.filename || ''}:${event.lineno || ''}`));
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason || '');
    show('REJECTION', reason);
  });
})();
