const list = document.getElementById('list');
const empty = document.getElementById('empty');

function send(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

function matchPatternToRegex(pattern) {
  try {
    const escaped = pattern.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$', 'i');
  } catch { return null; }
}

async function render() {
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const url = tab?.url || '';
  document.getElementById('currentUrl').textContent = url.replace(/^https?:\/\//, '');

  const { scripts } = await send({ type: 'getScripts' });
  const matching = scripts.filter(s => {
    if (!/^https?:/i.test(url)) return false;
    return (s.matches || []).some(p => {
      const re = matchPatternToRegex(p);
      return re && re.test(url);
    });
  });

  list.innerHTML = '';
  empty.hidden = matching.length > 0;

  for (const s of matching) {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name + (s.version ? ` (v${s.version})` : '');
    name.title = (s.matches || []).join('\n');

    const sw = document.createElement('label');
    sw.className = 'switch';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = s.enabled;
    cb.onchange = async () => {
      s.enabled = cb.checked;
      await send({ type: 'saveScript', script: s });
    };
    const sl = document.createElement('span');
    sl.className = 'slider';
    sw.append(cb, sl);

    li.append(name, sw);
    list.appendChild(li);
  }
}

document.getElementById('manage').onclick = () => chrome.runtime.openOptionsPage();
render();
