// SBR-bot – content script: intercept clicks on userscript links (*.user.js)
// and offer to open the dashboard install view instead of downloading.
(() => {
  function isUserscriptUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return /\.user\.js(\?|#|$)/.test(u.pathname + u.search + u.hash) ||
             /\.user\.js$/.test(u.pathname);
    } catch {
      return false;
    }
  }

  document.addEventListener('click', (e) => {
    // only main-button clicks without modifiers
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.defaultPrevented) return;

    const a = e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const url = a.href;
    if (!isUserscriptUrl(url)) return;

    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'openInstall', url });
  }, true);
})();
