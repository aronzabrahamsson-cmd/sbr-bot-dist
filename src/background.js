// SBR-bot – background service worker
// v0.6.0: userscripts run in the ISOLATED world (sandbox), which is immune to
//         page CSP — the most common reason scripts silently failed before.
//         Also: injects into all frames, and re-injects on SPA navigation.

const UPDATE_ALARM = 'sbr-bot-update';
const UPDATE_PERIOD_MIN = 30;

/* ---------- metadata parsing ---------- */

function parseMetadata(code) {
  const meta = {
    name: '', version: '', matches: [], excludes: [], updateURL: '',
    runAt: 'document-idle', description: ''
  };
  // normalize: strip BOM, unify line endings (Tampermonkey tolerates these)
  const norm = String(code)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const m = /^[ \t]*\/\/\s*==UserScript==\n?([\s\S]*?)^[ \t]*\/\/\s*==\/UserScript==/m.exec(norm);
  if (!m) return meta;
  for (const line of m[1].split('\n')) {
    const t = /^[ \t]*\/\/[ \t]*@([\w-]+)[ \t]+(.*)$/.exec(line);
    if (!t) continue;
    const [, key, val] = t;
    switch (key) {
      case 'name': meta.name = val.trim(); break;
      case 'version': meta.version = val.trim(); break;
      case 'match': meta.matches.push(val.trim()); break;
      case 'exclude':
      case 'exclude-match': meta.excludes.push(val.trim()); break;
      case 'updateURL':
      case 'downloadURL': if (!meta.updateURL) meta.updateURL = val.trim(); break;
      case 'run-at': meta.runAt = val.trim().toLowerCase(); break;
      case 'description': meta.description = val.trim(); break;
    }
  }
  if (!['document-start', 'document-end', 'document-idle'].includes(meta.runAt)) {
    meta.runAt = 'document-idle';
  }
  return meta;
}

function patternToRegex(pattern) {
  try {
    const p = pattern.trim();
    const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$', 'i');
  } catch {
    return null;
  }
}

function versionIsNewer(newV, oldV) {
  return compareVersions(newV, oldV) > 0;
}

function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/* ---------- storage ---------- */

async function getScripts() {
  const data = await chrome.storage.local.get('scripts');
  const scripts = data.scripts || [];
  for (const s of scripts) {
    if (!Array.isArray(s.matches)) {
      s.matches = s.match ? [s.match] : [];
      delete s.match;
    }
    if (!Array.isArray(s.excludes)) s.excludes = [];
    if (!s.runAt) s.runAt = 'document-idle';
    if (!s.version) s.version = '0.0.0';
  }
  return scripts;
}

async function setScripts(scripts) {
  await chrome.storage.local.set({ scripts });
}

/* ---------- GM storage: atomic per-key (v0.8) ----------
   Each script's values live under individual storage keys
   "gm_<scriptId>::<key>", so concurrent writes from different frames/tabs
   can never clobber each other (the old whole-object read-modify-write
   raced and lost data).
   Legacy format ("gm_<id>" -> {...values}) is migrated on read. */

function gmKey(storeKey, key) {
  return storeKey + '::' + key;
}

async function gmGetOne(storeKey, key) {
  const k = gmKey(storeKey, key);
  const data = await chrome.storage.local.get(k);
  if (k in data) return data[k];
  // legacy fallback: read from the old whole-object store
  const legacy = await chrome.storage.local.get(storeKey);
  const vals = legacy[storeKey];
  if (vals && key in vals) return vals[key];
  return undefined;
}

async function gmSetOne(storeKey, key, value) {
  await chrome.storage.local.set({ [gmKey(storeKey, key)]: value });
  // keep legacy copy in sync during transition (cheap safety net)
}

async function gmDelOne(storeKey, key) {
  await chrome.storage.local.remove(gmKey(storeKey, key));
}

async function gmListKeys(storeKey) {
  const all = await chrome.storage.local.get(null);
  const keys = [];
  for (const k of Object.keys(all)) {
    if (k.startsWith(storeKey + '::')) {
      keys.push(k.slice(storeKey.length + 2));
    } else if (k === storeKey && all[k] && typeof all[k] === 'object') {
      // legacy object store: list its keys
      keys.push(...Object.keys(all[k]));
    }
  }
  return [...new Set(keys)];
}

// migrate all legacy values of one script to per-key format (once)
async function gmMigrateLegacy(storeKey) {
  const data = await chrome.storage.local.get(storeKey);
  const vals = data[storeKey];
  if (!vals || typeof vals !== 'object') return;
  const perKey = {};
  for (const [k, v] of Object.entries(vals)) {
    perKey[gmKey(storeKey, k)] = v;
  }
  await chrome.storage.local.set(perKey);
  await chrome.storage.local.remove(storeKey);
}


function scriptMatches(script, url) {
  if (!script.enabled || !url || !/^https?:/i.test(url)) return false;
  const inc = (script.matches || []).some(p => {
    const re = patternToRegex(p);
    return re && re.test(url);
  });
  if (!inc) return false;
  const exc = (script.excludes || []).some(p => {
    const re = patternToRegex(p);
    return re && re.test(url);
  });
  return !exc;
}

/* ---------- injection ---------- */

// v0.7.0: userscripts run via chrome.userScripts.execute() in the USER_SCRIPT
// world. That world is EXEMPT from the page's Content-Security-Policy, which
// was silently killing scripts on CSP-strict pages (e.g. CMS admins).
// No eval/new Function is used at all: the bootstrap (GM shims) and the user
// code are concatenated into ONE script text and injected as code.

// The bootstrap runs in the USER_SCRIPT world on every page injection.
// chrome.runtime is available there because configureWorld({messaging:true}).
const BOOTSTRAP_SOURCE = `
window.__sbrInit = function (config) {
  const cache = config.preloaded || {};
  const storeKey = config.storeKey;
  const listeners = {};
  let listenerSeq = 0;
  const call = function (type, extra) {
    return chrome.runtime.sendMessage(Object.assign({ type: type, storeKey: storeKey }, extra || {}));
  };

  // live cache: storage changes from other frames/tabs update the local
  // snapshot, so GM_getValue always reflects fresh data
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      const prefix = storeKey + '::';
      for (const [k, change] of Object.entries(changes)) {
        if (!k.startsWith(prefix)) continue;
        const key = k.slice(prefix.length);
        const oldVal = key in cache ? cache[key] : undefined;
        if ('newValue' in change) cache[key] = change.newValue;
        else delete cache[key];
        // fire GM_addValueChangeListener handlers (remote only — the
        // writing frame fires its own below)
        const remote = change.remote !== undefined ? change.remote : true;
        if (remote) {
          for (const fn of Object.values(listeners)) {
            try { fn(key, oldVal, 'newValue' in change ? change.newValue : undefined, remote); }
            catch (e) { console.error('[SBR-bot] value listener error', e); }
          }
        }
      }
    });
  } catch (e) { /* storage API unavailable in this context */ }

  function GM_setValue(key, value) {
    const oldVal = key in cache ? cache[key] : undefined;
    cache[key] = value;
    call('gmSet', { key: key, value: value });
    for (const fn of Object.values(listeners)) {
      try { fn(key, oldVal, value, false); }
      catch (e) { console.error('[SBR-bot] value listener error', e); }
    }
  }
  function GM_getValue(key, def) {
    return key in cache ? cache[key] : def;
  }
  function GM_deleteValue(key) {
    delete cache[key];
    call('gmDel', { key: key });
  }
  function GM_listValues() {
    return Object.keys(cache);
  }
  function GM_addValueChangeListener(key, callback) {
    const id = 'l' + (++listenerSeq);
    listeners[id] = callback;
    return id;
  }
  function GM_removeValueChangeListener(listenerId) {
    delete listeners[listenerId];
  }
  // async live re-read of a single key from the background store
  function GM_refreshValue(key) {
    return call('gmGet', { key: key }).then(function (r) {
      if (r && r.ok && r.value !== undefined) cache[key] = r.value;
      return r ? r.value : undefined;
    });
  }


  function GM_xmlhttpRequest(opts) {
    opts = opts || {};
    call('gmXhr', {
      opts: {
        method: opts.method || 'GET',
        url: opts.url,
        headers: opts.headers || {},
        data: opts.data || null,
        responseType: opts.responseType || 'text',
        timeout: opts.timeout || 30000
      }
    }).then(function (r) {
      r = r || {};
      if (r.status === 0 && r.error) {
        if (r.error === 'timeout' && opts.ontimeout) {
          opts.ontimeout({ error: 'timeout', status: 0, readyState: 4 });
        } else if (opts.onerror) {
          opts.onerror({ error: r.error, status: 0, readyState: 4 });
        }
        return;
      }
      const details = {
        status: r.status,
        statusText: r.statusText || '',
        responseText: r.responseText || '',
        response: r.responseText || '',
        responseHeaders: r.responseHeaders || '',
        finalUrl: opts.url,
        readyState: 4
      };
      if (r.responseType === 'blob' && r.blobB64) {
        const bin = atob(r.blobB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        details.response = new Blob([bytes], { type: r.blobType || 'application/octet-stream' });
        details.responseText = undefined;
      }
      if ((opts.responseType || 'text') === 'json') {
        try { details.response = JSON.parse(r.responseText); }
        catch (e) { details.response = null; }
      }
      if (opts.onload) opts.onload(details);
    }).catch(function (err) {
      if (opts.onerror) opts.onerror({ error: String(err), status: 0, readyState: 4 });
    });
  }

  function GM_download(urlOrOpts, name) {
    const o = typeof urlOrOpts === 'object' ? urlOrOpts : { url: urlOrOpts };
    const url = o.url;
    const fname = name || o.name || 'download';
    if (/^blob:/i.test(url)) {
      // blob: URLs are origin-bound and invisible to the background worker;
      // download them page-side via a programmatic <a download> click
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = fname;
        (document.documentElement || document.body).appendChild(a);
        a.click();
        a.remove();
        if (o.onload) o.onload();
      } catch (e) {
        if (o.onerror) o.onerror({ error: String(e) });
      }
      return;
    }
    return call('gmDownload', { url: url, name: fname, saveAs: o.saveAs === true })
      .then(function (r) {
        r = r || {};
        if (r.ok) { if (o.onload) o.onload(); }
        else if (o.onerror) o.onerror({ error: r.error || 'download failed' });
      })
      .catch(function (err) {
        if (o.onerror) o.onerror({ error: String(err) });
      });
  }

  async function GM_setClipboard(text) {
    try { await navigator.clipboard.writeText(String(text)); }
    catch (e) { await call('gmClipboard', { text: String(text) }); }
  }

  async function GM_notification(textOrOpts, title) {
    const o = typeof textOrOpts === 'object' ? textOrOpts : { text: textOrOpts, title: title };
    await call('gmNotification', { title: o.title || 'SBR-bot', text: o.text || '' });
  }

  function GM_addStyle(css) {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    return style;
  }

  const GM_info = { script: { name: config.name, version: config.version } };
  const GM = {
    setValue: GM_setValue,
    getValue: GM_getValue,
    deleteValue: GM_deleteValue,
    listValues: GM_listValues,
    addValueChangeListener: GM_addValueChangeListener,
    removeValueChangeListener: GM_removeValueChangeListener,
    xmlHttpRequest: GM_xmlhttpRequest,
    download: GM_download,
    setClipboard: GM_setClipboard,
    notification: GM_notification,
    addStyle: GM_addStyle,
    info: GM_info
  };

  window.GM_setValue = GM_setValue;
  window.GM_getValue = GM_getValue;
  window.GM_deleteValue = GM_deleteValue;
  window.GM_listValues = GM_listValues;
  window.GM_addValueChangeListener = GM_addValueChangeListener;
  window.GM_removeValueChangeListener = GM_removeValueChangeListener;
  window.GM_xmlhttpRequest = GM_xmlhttpRequest;
  window.GM_download = GM_download;
  window.GM_setClipboard = GM_setClipboard;
  window.GM_notification = GM_notification;
  window.GM_addStyle = GM_addStyle;
  window.GM_info = GM_info;
  window.GM = GM;
};
`;

// record last injection errors per script for the dashboard
async function recordError(scriptId, message) {
  const data = await chrome.storage.local.get('injectErrors');
  const errs = data.injectErrors || {};
  errs[scriptId] = { message: String(message), at: Date.now() };
  await chrome.storage.local.set({ injectErrors: errs });
}
async function clearError(scriptId) {
  const data = await chrome.storage.local.get('injectErrors');
  const errs = data.injectErrors || {};
  if (errs[scriptId]) {
    delete errs[scriptId];
    await chrome.storage.local.set({ injectErrors: errs });
  }
}

// userScripts API must be enabled by the user (chrome://extensions →
// SBR-bot → "Tillåt användarskript"). configureWorld enables messaging.
async function ensureUserScriptsWorld() {
  if (!chrome.userScripts?.execute) return false;
  try {
    await chrome.userScripts.configureWorld({ messaging: true });
    return true;
  } catch {
    return false;
  }
}

async function injectScript(tabId, script, frameId) {
  try {
    if (!await ensureUserScriptsWorld()) {
      throw new Error(
        'chrome.userScripts ej aktivt — aktivera "Tillåt användarskript" för SBR-bot i chrome://extensions'
      );
    }
    const storeKey = 'gm_' + script.id;
    // gate legacy migration so it runs only once per script, not on every injection
    const migratedKey = 'migrated_' + script.id;
    const migrated = await chrome.storage.local.get(migratedKey);
    if (!migrated[migratedKey]) {
      await gmMigrateLegacy(storeKey);
      await chrome.storage.local.set({ [migratedKey]: true });
    }
    const preloaded = {};
    for (const k of await gmListKeys(storeKey)) {
      preloaded[k] = await gmGetOne(storeKey, k);
    }
    const config = {
      id: script.id,
      name: script.name,
      version: script.version || '0.0.0',
      storeKey,
      preloaded
    };
    // ONE code text: shims first, then the userscript — no eval, so the
    // page CSP can never block it (USER_SCRIPT world is exempt anyway).
    // Double-injection guard: SPA re-injection (onHistoryStateUpdated) must not
    // re-run __sbrInit + the userscript in the same frame. The flag is per-window,
    // so new frames (allFrames) still inject fresh.
    const guardFlag = '__sbrBotLoaded_' + String(script.id).replace(/[^\w]/g, '_');
    const source =
      BOOTSTRAP_SOURCE +
      '\nif (!window.' + guardFlag + ') { window.' + guardFlag + ' = true;\n' +
      'window.__sbrInit(' + JSON.stringify(config) + ');\n' +
      '(function () {\n' + script.code + '\n})();\n}';
    await chrome.userScripts.execute({
      target: frameId != null
        ? { tabId, frameIds: [frameId] }
        : { tabId, allFrames: true },
      js: [{ code: source }],
      world: 'USER_SCRIPT',
      injectImmediately: true
    });
    await clearError(script.id);
  } catch (e) {
    console.warn(`[SBR-bot] could not inject "${script.name}" into tab ${tabId}:`, e.message);
    await recordError(script.id, e.message);
  }
}
async function injectMatching(tabId, url) {
  const scripts = await getScripts();
  for (const s of scripts.filter(s => scriptMatches(s, url))) {
    await injectScript(tabId, s);
  }
}

/* ---------- updates ---------- */

async function updateScripts(id) {
  const scripts = await getScripts();
  let updated = 0;
  for (const s of scripts) {
    if (!s.updateURL) continue;
    if (id && s.id !== id) continue;
    try {
      const res = await fetch(s.updateURL, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const code = await res.text();
      if (!code.trim()) continue;
      const meta = parseMetadata(code);
      if (!versionIsNewer(meta.version, s.version)) continue;
      s.code = code;
      s.version = meta.version;
      s.name = meta.name || s.name;
      s.matches = meta.matches.length ? meta.matches : s.matches;
      s.excludes = meta.excludes.length ? meta.excludes : s.excludes;
      s.updateURL = meta.updateURL || s.updateURL;
      s.runAt = meta.runAt || s.runAt;
      s.updatedAt = Date.now();
      updated++;
    } catch (e) {
      console.warn(`[SBR-bot] update failed for "${s.name}":`, e.message);
    }
  }
  if (updated > 0) await setScripts(scripts);
  return updated;
}

/* ---------- lifecycle ---------- */

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: UPDATE_PERIOD_MIN });
});

/* ---------- injection triggers: frame-aware (v0.9) ----------
   webNavigation events fire per FRAME with details.url set to that
   frame's URL, so scripts also run inside iframes (e.g. a new-tab page
   embedding https://sbr.wiki/). frameIds targets the exact frame. */

// document-start: as soon as the frame's navigation commits
chrome.webNavigation.onCommitted.addListener(async (details) => {
  const scripts = await getScripts();
  for (const s of scripts.filter(s =>
    s.runAt === 'document-start' && scriptMatches(s, details.url))) {
    injectScript(details.tabId, s, details.frameId);
  }
});

// document-end: when the frame's DOM is parsed
chrome.webNavigation.onDOMContentLoaded.addListener(async (details) => {
  const scripts = await getScripts();
  for (const s of scripts.filter(s =>
    s.runAt === 'document-end' && scriptMatches(s, details.url))) {
    injectScript(details.tabId, s, details.frameId);
  }
});

// document-idle: when the frame has finished loading
chrome.webNavigation.onCompleted.addListener(async (details) => {
  const scripts = await getScripts();
  for (const s of scripts.filter(s =>
    s.runAt === 'document-idle' && scriptMatches(s, details.url))) {
    injectScript(details.tabId, s, details.frameId);
  }
});

// SPA navigation (pushState/replaceState): re-inject matching scripts
// in the frame that navigated
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  const scripts = await getScripts();
  for (const s of scripts.filter(s => scriptMatches(s, details.url))) {
    injectScript(details.tabId, s, details.frameId);
  }
});

/* ---------- messages ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'injectNow': {
        const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        if (tab?.id != null && tab.url) {
          await injectMatching(tab.id, tab.url);
          const matching = (await getScripts()).filter(s => scriptMatches(s, tab.url));
          sendResponse({ ok: true, count: matching.length });
        } else {
          sendResponse({ ok: false, error: 'Ingen aktiv flik med URL' });
        }
        break;
      }
      case 'getScripts':
        sendResponse({ ok: true, scripts: await getScripts() });
        break;
      case 'getInjectErrors': {
        const data = await chrome.storage.local.get('injectErrors');
        sendResponse({ ok: true, errors: data.injectErrors || {} });
        break;
      }
      case 'saveScript': {
        const scripts = await getScripts();
        const s = msg.script;
        const i = scripts.findIndex(x => x.id === s.id);
        if (i >= 0) scripts[i] = s; else scripts.push(s);
        await setScripts(scripts);
        sendResponse({ ok: true });
        break;
      }
      case 'deleteScript':
        await setScripts((await getScripts()).filter(s => s.id !== msg.id));
        sendResponse({ ok: true });
        break;
      case 'updateScript':
        sendResponse({ ok: true, updated: await updateScripts(msg.id || null) });
        break;
      case 'openInstall': {
        const dash = chrome.runtime.getURL('src/dashboard.html');
        const full = dash + '?install=' + encodeURIComponent(msg.url);
        const tabs = await chrome.tabs.query({ url: dash });
        if (tabs.length) {
          await chrome.tabs.update(tabs[0].id, { active: true, url: full });
          const win = await chrome.windows.get(tabs[0].windowId);
          if (!win.focused) await chrome.windows.update(tabs[0].windowId, { focused: true });
        } else {
          await chrome.tabs.create({ url: full });
        }
        sendResponse({ ok: true });
        break;
      }

      /* ----- GM bridge handlers (from sandbox) ----- */
      case 'gmXhr': {
        try {
          const opts = msg.opts || {};
          const { method, url, headers, data } = opts;
          const res = await fetch(url, {
            method: method || 'GET',
            headers: headers || {},
            body: data || undefined,
            signal: AbortSignal.timeout(opts.timeout || 30000)
          });
          const responseHeaders = [...res.headers.entries()]
            .map(([k, v]) => k + ': ' + v).join('\r\n');
          const responseType = opts.responseType || 'text';
          if (responseType === 'blob') {
            // structured clone through sendResponse is unreliable for Blobs:
            // transfer base64 and rebuild the Blob page-side, preserving MIME type
            const blob = await res.blob();
            const buf = await blob.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let bin = '';
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
              bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
            }
            sendResponse({
              status: res.status,
              statusText: res.statusText,
              responseHeaders,
              responseType: 'blob',
              blobType: blob.type || '',
              blobB64: btoa(bin)
            });
          } else {
            sendResponse({
              status: res.status,
              statusText: res.statusText,
              responseText: await res.text(),
              responseHeaders,
              responseType
            });
          }
        } catch (e) {
          const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
          sendResponse({ status: 0, responseText: '', error: isTimeout ? 'timeout' : e.message });
        }
        break;
      }
      case 'gmSet': {
        await gmSetOne(msg.storeKey, msg.key, msg.value);
        sendResponse({ ok: true });
        break;
      }
      case 'gmGet': {
        sendResponse({ ok: true, value: await gmGetOne(msg.storeKey, msg.key) });
        break;
      }
      case 'gmDel': {
        await gmDelOne(msg.storeKey, msg.key);
        sendResponse({ ok: true });
        break;
      }
      case 'gmList': {
        sendResponse({ ok: true, keys: await gmListKeys(msg.storeKey) });
        break;
      }
      case 'gmMigrate': {
        await gmMigrateLegacy(msg.storeKey);
        sendResponse({ ok: true });
        break;
      }
      case 'setExtSource': {
        await chrome.storage.local.set({ extSourceUrl: msg.url || '' });
        sendResponse({ ok: true });
        break;
      }
      case 'checkExtUpdate': {
        // compare installed extension version vs manifest.json at dist repo
        const current = chrome.runtime.getManifest().version;
        const stored = await chrome.storage.local.get('extSourceUrl');
        const url = stored.extSourceUrl;
        if (!url) {
          sendResponse({ ok: false, error: 'Ingen käll-URL angiven i kontrollpanelen' });
          break;
        }
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const remoteManifest = await res.json();
          const remoteV = remoteManifest.version || '';
          const newer = compareVersions(remoteV, current) > 0;
          sendResponse({ ok: true, current, remote: remoteV, newer });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }
      case 'gmDownload':
        if (/^blob:/i.test(msg.url)) {
          sendResponse({ ok: false, error: 'blob: URLs must be downloaded page-side' });
          break;
        }
        try {
          const downloadId = await chrome.downloads.download({
            url: msg.url,
            filename: msg.name,
            saveAs: msg.saveAs === true
          });
          sendResponse({ ok: true, id: downloadId });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      case 'gmClipboard':
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id != null) {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: (text) => navigator.clipboard.writeText(text),
              args: [msg.text]
            });
          }
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      case 'gmNotification':
        try {
          new Notification(msg.title || 'SBR-bot', { body: msg.text || '' });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
    }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== UPDATE_ALARM) return;
  await updateScripts(null);
});
