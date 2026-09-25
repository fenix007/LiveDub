// Субтитры поверх страницы. Внедряется из боковой панели через chrome.scripting;
// повторное внедрение ничего не делает. Ключей и настроек здесь нет.
//
// Плашка фиксированного размера: две строки перевода и строка оригинала.
// Новый текст дописывается снизу, старые строки уходят вверх за край (roll-up,
// как у телевизионных субтитров), поэтому плашка не прыгает и не растёт.
// У черновика совпавшее начало не перерисовывается — меняется только хвост.
(() => {
  if (window.__liveDubSubtitles) return;
  window.__liveDubSubtitles = true;

  const DRAFT_MIN_INTERVAL_MS = 800;
  const HIDE_AFTER_FINAL_MS = 7000;
  const HIDE_AFTER_DRAFT_MS = 12000;
  const KEEP_LINES = 3;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .box { position: absolute; transform: translate(-50%, -100%); box-sizing: border-box;
        padding: 8px 16px 9px; border-radius: 10px; background: rgba(10, 12, 16, .8); color: #fff;
        font: 500 var(--fs, 22px)/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        text-shadow: 0 1px 2px rgba(0,0,0,.6); transition: opacity .3s; }
      .box.off { opacity: 0; }
      .tr { height: 2.7em; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end;
        -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 .5em);
                mask-image: linear-gradient(to bottom, transparent 0, #000 .5em); }
      .line { flex-shrink: 0; }
      .line.old { opacity: .6; }
      .line.draft { opacity: .85; }
      .line.stale { opacity: .35; }
      .fresh { animation: fresh .35s ease-out; }
      @keyframes fresh { from { opacity: .15; } to { opacity: 1; } }
      .src { height: 1.4em; margin-top: 4px; font-size: .6em; font-weight: 400; opacity: .7;
        display: flex; justify-content: flex-end; overflow: hidden; white-space: nowrap;
        -webkit-mask-image: linear-gradient(to right, transparent 0, #000 2em);
                mask-image: linear-gradient(to right, transparent 0, #000 2em); }
      .src span { flex-shrink: 0; }
    </style>
    <div class="box off"><div class="tr"></div><div class="src"><span></span></div></div>`;
  const box = root.querySelector('.box');
  const trEl = root.querySelector('.tr');
  const srcEl = root.querySelector('.src span');

  let lines = []; // { id, text, final, el }
  let hideTimer = null;
  let pendingDraft = null;
  let draftTimer = null;
  let lastDraftAt = 0;

  // В полноэкранном режиме видны только потомки fullscreenElement.
  const mount = () => {
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && !(fullscreen instanceof HTMLVideoElement) ? fullscreen : document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  };

  // Плашка стоит над нижней частью самого крупного видимого видео, иначе — внизу окна.
  const place = () => {
    const vw = innerWidth, vh = innerHeight;
    let best = null, bestArea = 0;
    for (const video of document.querySelectorAll('video')) {
      const r = video.getBoundingClientRect();
      const w = Math.min(r.right, vw) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      if (w > 200 && h > 120 && w * h > bestArea) { best = r; bestArea = w * h; }
    }
    const area = best && best.bottom <= vh + 40 && best.top >= -40
      ? { left: best.left, width: best.width, bottom: best.bottom - best.height * 0.12 }
      : { left: 0, width: vw, bottom: vh * 0.91 };
    const width = Math.min(880, area.width * 0.9, vw * 0.94);
    const fs = Math.round(Math.max(16, Math.min(30, width / 36)));
    box.style.setProperty('--fs', `${fs}px`);
    box.style.width = `${width}px`;
    box.style.left = `${area.left + area.width / 2}px`;
    box.style.top = `${Math.min(area.bottom, vh - 8)}px`;
  };
  let placeQueued = false;
  const queuePlace = () => {
    if (placeQueued || box.classList.contains('off')) return;
    placeQueued = true;
    requestAnimationFrame(() => { placeQueued = false; place(); });
  };
  addEventListener('scroll', queuePlace, { passive: true, capture: true });
  addEventListener('resize', queuePlace);
  document.addEventListener('fullscreenchange', () => { mount(); queuePlace(); });
  mount();

  const words = (text) => text.split(/\s+/).filter(Boolean);

  // Совпавшее по словам начало остаётся тем же текстовым узлом, мигает только хвост.
  const renderLine = (line, text) => {
    if (line.text === text) return;
    const prev = words(line.text), next = words(text);
    let same = 0;
    while (same < prev.length && same < next.length && prev[same] === next[same]) same++;
    line.el.textContent = '';
    if (same) line.el.append(`${next.slice(0, same).join(' ')} `);
    if (same < next.length) {
      const tail = document.createElement('span');
      tail.className = 'fresh';
      tail.textContent = next.slice(same).join(' ');
      line.el.append(tail);
    }
    line.text = text;
  };

  const hide = () => {
    box.classList.add('off');
    clearTimeout(draftTimer);
    draftTimer = null;
    pendingDraft = null;
    lines = [];
    trEl.textContent = '';
    srcEl.textContent = '';
  };

  const apply = ({ id, translation, original, final }) => {
    let line = lines.find((l) => l.id === id);
    if (!line) {
      line = { id, text: '', final: false, el: document.createElement('div') };
      line.el.className = 'line';
      lines.push(line);
      trEl.append(line.el);
      while (lines.length > KEEP_LINES) lines.shift().el.remove();
    }
    if (line.final && !final) return; // запоздалый черновик после финала
    renderLine(line, translation);
    line.el.classList.remove('stale');
    line.final = !!final;
    for (const l of lines) {
      l.el.classList.toggle('old', l !== lines.at(-1));
      l.el.classList.toggle('draft', !l.final);
    }
    if (line === lines.at(-1)) srcEl.textContent = original || '';

    const wasHidden = box.classList.contains('off');
    box.classList.remove('off');
    if (wasHidden) place();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, final ? HIDE_AFTER_FINAL_MS : HIDE_AFTER_DRAFT_MS);
  };

  // Черновики не чаще раза в DRAFT_MIN_INTERVAL_MS, финал — сразу.
  const receive = (message) => {
    mount();
    if (message.final) {
      if (pendingDraft?.id === message.id) { clearTimeout(draftTimer); draftTimer = null; pendingDraft = null; }
      apply(message);
      return;
    }
    pendingDraft = message;
    if (draftTimer) return;
    const wait = Math.max(0, lastDraftAt + DRAFT_MIN_INTERVAL_MS - performance.now());
    draftTimer = setTimeout(() => {
      draftTimer = null;
      if (!pendingDraft) return;
      lastDraftAt = performance.now();
      const next = pendingDraft;
      pendingDraft = null;
      apply(next);
    }, wait);
  };

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'tt-subtitle-clear') {
      clearTimeout(hideTimer);
      hide();
    } else if (message?.type === 'tt-subtitle-stale') {
      lines.find((l) => l.id === message.id)?.el.classList.toggle('stale', !!message.stale);
      if (message.stale && pendingDraft?.id === message.id) pendingDraft = null;
    } else if (message?.type === 'tt-subtitle') {
      receive(message);
    }
  });
})();
