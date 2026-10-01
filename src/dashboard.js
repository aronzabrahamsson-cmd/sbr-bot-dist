const $ = id => document.getElementById(id);
const tbody = $('tbody');
const editor = $('editor');

function send(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleString('sv-SE') : '—';
}

/* ---- client-side metadata parser (same rules as background) ---- */
function parseMetadata(code) {
  const meta = { name: '', version: '', matches: [], excludes: [], updateURL: '', runAt: '' };
  // normalize: strip BOM, unify line endings, so headers with \r\n or a
  // byte-order mark still parse (Tampermonkey tolerates all of this)
  const norm = String(code)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const m = /^[ \t]*\/\/\s*==UserScript==\n?([\s\S]*?)^[ \t]*\/\/\s*==\/UserScript==/m.exec(norm);
  if (!m) return meta;
  for (const line of m[1].split('\n')) {
    const t = /^[ \t]*\/\/[ \t]*@([\w-]+)[ \t]+(.*)$/.exec(line);
    if (!t) continue;
    const [, key, val] = t;
    if (key === 'name') meta.name = val.trim();
    else if (key === 'version') meta.version = val.trim();
    else if (key === 'match') meta.matches.push(val.trim());
    else if (key === 'exclude' || key === 'exclude-match') meta.excludes.push(val.trim());
    else if ((key === 'updateURL' || key === 'downloadURL') && !meta.updateURL) {
      meta.updateURL = val.trim();
    } else if (key === 'run-at') meta.runAt = val.trim().toLowerCase();
  }
  return meta;
}

let suppressAuto = false;

function applyMetaToForm(code) {
  if (suppressAuto) return;
  const meta = parseMetadata(code);
  const found = meta.name || meta.version || meta.matches.length || meta.updateURL;
  if (!found) {
    $('metaNote').textContent = '';
    return;
  }
  if (meta.name) $('name').value = meta.name;
  if (meta.version) $('version').value = meta.version;
  if (meta.updateURL) $('updateURL').value = meta.updateURL;
  if (meta.runAt) $('runAt').value = meta.runAt;
  
  if (meta.excludes.length) $('excludes').value = meta.excludes.join('\n');
  $('metaNote').textContent =
    `✓ Metadata hittad: ${meta.name || '—'} v${meta.version || '—'}, ` +
    `${meta.matches.length} match-mönster${meta.excludes.length ? `, ${meta.excludes.length} undantag` : ''}` +
    `${meta.updateURL ? ', uppdaterings-URL' : ''}${meta.runAt ? ', run-at: ' + meta.runAt : ''}`;
}

function openEditor(s) {
  $('editorTitle').textContent = s ? 'Redigera script' : 'Nytt script';
  $('id').value = s?.id || '';
  $('name').value = s?.name || '';
  $('version').value = s?.version || '';
  $('updateURL').value = s?.updateURL || '';
  $('runAt').value = s?.runAt || 'document-idle';

  $('excludes').value = (s?.excludes || []).join('\n');
  $('code').value = s?.code || '';
  $('metaNote').textContent = s ? 'Metadata hämtas om automatiskt om du klistrar in ny kod.' : '';
  suppressAuto = false;
  editor.classList.add('visible');
  editor.scrollIntoView({ behavior: 'smooth' });
  $('code').focus();
}

function closeEditor() {
  editor.classList.remove('visible');
  $('id').value = '';
  $('metaNote').textContent = '';
}

function makeSwitch(checked, onchange) {
  const sw = document.createElement('label');
  sw.className = 'switch';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = checked;
  cb.onchange = onchange;
  const sl = document.createElement('span');
  sl.className = 'slider';
  sw.append(cb, sl);
  return sw;
}

async function render() {
  const { scripts } = await send({ type: 'getScripts' });
  const errRes = await send({ type: 'getInjectErrors' });
  const errs = errRes.errors || {};
  tbody.innerHTML = '';
  for (const s of scripts) {
    const tr = document.createElement('tr');

    const tdOn = document.createElement('td');
    tdOn.appendChild(makeSwitch(s.enabled, async () => {
      s.enabled = !s.enabled;
      await send({ type: 'saveScript', script: s });
      render();
    }));

    const tdName = document.createElement('td');
    tdName.textContent = s.name;
    const e = errs[s.id];
    if (e) {
      const d = document.createElement('div');
      d.className = 'hint';
      d.style.color = '#c05040';
      d.textContent = '⚠️ injekteringsfel: ' + e.message;
      tdName.appendChild(d);
    }

    const tdVer = document.createElement('td');
    tdVer.className = 'ver';
    tdVer.textContent = s.version ? 'v' + s.version : '—';

    const tdMatch = document.createElement('td');
    tdMatch.className = 'match-list';
    for (const p of (s.matches || []).slice(0, 3)) {
      const d = document.createElement('div');
      d.textContent = p;
      d.title = p;
      tdMatch.appendChild(d);
    }
    if ((s.matches || []).length > 3) {
      const d = document.createElement('div');
      d.textContent = `+ ${s.matches.length - 3} till`;
      tdMatch.appendChild(d);
    }
    if ((s.excludes || []).length) {
      const d = document.createElement('div');
      d.textContent = `⊘ ${s.excludes.length} undantag`;
      d.style.color = '#c05040';
      tdMatch.appendChild(d);
    }

    const tdUpdated = document.createElement('td');
    tdUpdated.className = 'updated';
    tdUpdated.textContent = fmtDate(s.updatedAt);

    const tdUpdate = document.createElement('td');
    const upd = document.createElement('button');
    upd.className = 'update-btn';
    upd.textContent = '♻️';
    upd.title = 'Sök efter senaste versionen';
    upd.disabled = !s.updateURL;
    upd.style.opacity = s.updateURL ? '1' : '.35';
    upd.onclick = async () => {
      upd.textContent = '⏳';
      const res = await send({ type: 'updateScript', id: s.id });
      upd.textContent = res.updated > 0 ? '✅' : '♻️';
      setTimeout(() => (upd.textContent = '♻️'), 1500);
      render();
    };
    tdUpdate.appendChild(upd);

    const tdActions = document.createElement('td');
    tdActions.className = 'actions';
    const edit = document.createElement('button');
    edit.textContent = 'Ändra';
    edit.onclick = () => openEditor(s);
    const del = document.createElement('button');
    del.textContent = 'Ta bort';
    del.className = 'ghost';
    del.onclick = async () => {
      if (confirm(`Ta bort "${s.name}"?`)) {
        await send({ type: 'deleteScript', id: s.id });
        render();
      }
    };
    tdActions.append(edit, del);

    tr.append(tdOn, tdName, tdVer, tdMatch, tdUpdated, tdUpdate, tdActions);
    tbody.appendChild(tr);
  }
}

$('addBtn').onclick = () => openEditor(null);

// auto-parse metadata while typing/pasting code
$('code').addEventListener('input', e => applyMetaToForm(e.target.value));

$('save').onclick = async () => {
  const meta = parseMetadata($('code').value);
  const splitLines = (v) => v.split('\n').map(l => l.trim()).filter(Boolean);

  const formExcludes = splitLines($('excludes').value);
  const script = {
    id: $('id').value || crypto.randomUUID(),
    name: $('name').value.trim() || meta.name,
    version: $('version').value.trim() || meta.version || '',
    updateURL: $('updateURL').value.trim() || meta.updateURL || '',
    runAt: $('runAt').value || meta.runAt || 'document-idle',
    matches: meta.matches,
    excludes: formExcludes.length ? formExcludes : meta.excludes,
    code: $('code').value,
    enabled: true,
    updatedAt: Date.now()
  };
  if (!script.name || !script.code.trim()) {
    $('status').textContent = 'Koden måste ha @name (eller fyll i namn).';
    setTimeout(() => ($('status').textContent = ''), 2500);
    return;
  }
  if (!script.matches.length) {
    $('status').textContent = 'Inga @match-rader hittades — ange minst en URL.';
    setTimeout(() => ($('status').textContent = ''), 2500);
    return;
  }
  await send({ type: 'saveScript', script });
  $('status').textContent = 'Sparat ✓';
  setTimeout(() => ($('status').textContent = ''), 1500);
  closeEditor();
  render();
};

$('cancel').onclick = closeEditor;

// Tab = två mellanslag i kodeditorn
$('code').addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const t = e.target;
    const start = t.selectionStart, end = t.selectionEnd;
    t.value = t.value.slice(0, start) + '  ' + t.value.slice(end);
    t.selectionStart = t.selectionEnd = start + 2;
  }
});

render();

/* ---------- extension update check ---------- */
(async () => {
  const { extSourceUrl } = await chrome.storage.local.get('extSourceUrl');
  if (extSourceUrl) $('extSource').value = extSourceUrl;
})();

$('checkExt').onclick = async () => {
  const url = $('extSource').value.trim();
  $('extStatus').textContent = 'Kontrollerar…';
  if (url) await send({ type: 'setExtSource', url });
  const res = await send({ type: 'checkExtUpdate' });
  if (!res.ok) {
    $('extStatus').textContent = '❌ ' + (res.error || 'Kunde inte kontrollera');
    return;
  }
  $('extStatus').textContent = res.newer
    ? `⬆️ Ny version: v${res.remote} (du har v${res.current}) — kör git pull och ladda om tillägget (↻)`
    : `✓ Senaste versionen (v${res.current})`;
};

/* ---------- .user.js install flow ---------- */
// Dashboard opened with ?install=<url> (from a clicked userscript link):
// fetch the script, parse metadata, ask "install/update?", compare versions.

async function runInstallFlow(url) {
  const dlg = $('installDialog');
  const info = $('installInfo');
  const metaBox = $('installMeta');
  dlg.classList.add('open');
  info.textContent = `Hämtar ${url} …`;
  metaBox.textContent = '';

  let code;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    code = await res.text();
  } catch (e) {
    info.textContent = `❌ Kunde inte hämta scriptet: ${e.message}`;
    setTimeout(() => (dlg.classList.remove("open")), 2500);
    return;
  }

  const meta = parseMetadata(code);
  if (!meta.name) {
    // diagnostic: show WHAT was actually fetched, so the cause is visible
    const looksHtml = /^\s*<(?:!doctype|html|\?xml)/i.test(code);
    const snippet = code.slice(0, 200).replace(/[<>&]/g, c =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    info.innerHTML = looksHtml
      ? '❌ Servern returnerade en <b>HTML-sida</b>, inte ett userscript (inloggning/redirect/fel?). URL:en kan behöva vara en rå "raw"-länk.'
      : `❌ Ingen ==UserScript==-metadata hittades i filen (${code.length} tecken). Så här börjar den:<br><code style="word-break:break-all">${snippet}</code>`;
    return;
  }

  // find existing script with same name
  const { scripts } = await send({ type: 'getScripts' });
  const existing = scripts.find(s => s.name === meta.name);

  $('installTitle').textContent = existing ? 'Uppdatera script' : 'Installera script';
  info.innerHTML = existing
    ? `Vill du uppdatera scriptet <b>${meta.name}</b>?`
    : `Vill du installera scriptet <b>${meta.name}</b>?`;

  metaBox.innerHTML = '';
  const rows = [
    ['Version', meta.version ? 'v' + meta.version : '—'],
    ['Status', existing ? `installerad v${existing.version || '?'}` : 'nytt script'],
    ['Matchar', (meta.matches || []).join(', ') || '—'],
    ['Uppdaterings-URL', meta.updateURL || '—']
  ];
  if (existing && meta.version) {
    const newer = compareVersions(meta.version, existing.version) > 0;
    rows[1] = ['Status', newer
      ? `✅ ny version tillgänglig (du har v${existing.version || '?'})`
      : `⚠️ du har redan v${existing.version || '?'}`];
  }
  for (const [k, v] of rows) {
    const d = document.createElement('div');
    d.innerHTML = `<b>${k}:</b> ${v}`;
    metaBox.appendChild(d);
  }

  $('installYes').onclick = async () => {
    const script = {
      id: existing?.id || crypto.randomUUID(),
      name: meta.name,
      version: meta.version || '',
      updateURL: meta.updateURL || url,
      runAt: meta.runAt || 'document-idle',
      matches: meta.matches || [],
      excludes: meta.excludes || [],
      code,
      enabled: true,
      updatedAt: Date.now()
    };
    if (!script.matches.length) {
      info.textContent = '❌ Scriptet saknar @match-rader — kan inte installeras.';
      return;
    }
    await send({ type: 'saveScript', script });
    dlg.classList.remove('open');
    history.replaceState(null, '', location.pathname);
    render();
  };
  $('installCancel').onclick = () => {
    dlg.classList.remove('open');
    history.replaceState(null, '', location.pathname);
  };
}

// semver-ish compare: >0 if a is newer than b
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

const installParam = new URLSearchParams(location.search).get('install');
if (installParam) runInstallFlow(installParam);
