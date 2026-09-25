// Субтитры поверх страницы. Внедряется из боковой панели через chrome.scripting;
// повторное внедрение ничего не делает. Ключей и настроек здесь нет.
//
// Плашка фиксированного размера с запасом: три строки перевода и строка оригинала.
// Слово, раз появившись, остаётся на своём месте: текст дописывается только
// вправо и вниз. Когда место кончилось, страница перелистывается целиком —
// не влезшее слово начинает новую страницу с верхней строки.
// У черновика совпавшее начало не перерисовывается — проявляется только хвост.
(() => {
  if (window.__liveDubSubtitles) return;
  window.__liveDubSubtitles = true;

  const DRAFT_MIN_INTERVAL_MS = 800;
  // Черновик, переписывающий уже показанные слова (а не только дописывающий),
  // принимается не чаще этого: иначе фраза мечется между вариантами перевода.
  const REWRITE_MIN_INTERVAL_MS = 2500;
  const REWRITE_TOLERATED_WORDS = 2;
  // Хвост, отрезанный финалом (фразу разрезали по предложению), виден до прихода
  // перевода следующей фразы — чтобы текст не пропадал и не появлялся снова.
  const CARRY_MS = 2000;
  const HIDE_AFTER_FINAL_MS = 10000;
  // Если новых слов больше, чем страница, они показываются постранично:
  // столько времени на слово, но не меньше PAGE_MIN_MS на страницу.
  const PAGE_MS_PER_WORD = 220;
  const PAGE_MIN_MS = 2500;
  const HIDE_AFTER_DRAFT_MS = 12000;
  const TRANSLATION_LINES = 3;
  // Страница держится хотя бы столько, даже если текст уже не влезает.
  const PAGE_DWELL_MS = 1200;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .box { position: absolute; transform: translate(-50%, -100%); box-sizing: border-box;
        padding: 8px 16px 9px; border-radius: 10px; background: rgba(10, 12, 16, .8); color: #fff;
        font: 500 var(--fs, 22px)/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        text-align: left; text-shadow: 0 1px 2px rgba(0,0,0,.6); transition: opacity .3s; }
      .box.off { opacity: 0; }
      .tr, .src { position: relative; overflow: hidden; overflow-wrap: anywhere; }
      .tr { height: ${TRANSLATION_LINES * 1.35}em; }
      .src { height: 1.35em; margin-top: 4px; font-size: .6em; font-weight: 400; opacity: .7; }
      .old { opacity: .6; }
      .draft { opacity: .85; }
      .stale { opacity: .35; }
      .fresh { animation: fresh .35s ease-out; }
      @keyframes fresh { from { opacity: .15; } to { opacity: 1; } }
      .ghost { position: absolute; inset: 0; pointer-events: none; animation: page-out .22s ease-in forwards; }
      .ghost * { animation: none !important; }
      .flip > span { animation: page-in .3s ease-out .1s both; }
      @keyframes page-out { to { opacity: 0; transform: translateY(-.3em); } }
      @keyframes page-in { from { opacity: 0; } to { opacity: 1; } }
    </style>
    <div class="box off"><div class="tr"></div><div class="src"></div></div>`;
  const box = root.querySelector('.box');

  const words = (text) => (text || '').split(/\s+/).filter(Boolean);

  // Выводит сегменты (фразы) по словам с позиции start — первого слова страницы.
  // Страница листается, когда текст не влез или когда новая фраза начинается уже
  // на нижней строке: так смена страницы чаще приходится на границу фраз.
  // Новая страница начинается с начала фразы, если та влезает, иначе с первого
  // нового слова; не влезшее ждёт следующих страниц (turn()). Между сменами
  // страниц не меньше minDwellMs, смена плавная: старая страница уходит, новая
  // проявляется. Слова, которых не было в прошлом выводе фразы, проявляются.
  const createPager = (el, { lines, minDwellMs = 0 }) => {
    let start = null; // { key, index } — первое слово страницы
    let shown = new Map(); // key -> слова, выведенные в прошлый раз
    let next = null; // { key, index } — начало следующей страницы
    let nextAt = 0; // раньше этого момента следующую страницу не показывать
    let flippedAt = -Infinity;
    let flipTimer = null;
    let lastSegments = [];
    const sameWord = (a, b) => a.key === b.key && a.index === b.index;
    const draw = (segments, freshFrom) => {
      const ghost = el.querySelector(':scope > .ghost');
      el.textContent = '';
      const spans = [];
      const from = segments.findIndex((s) => s.key === start.key);
      for (const segment of segments.slice(from)) {
        const wrap = document.createElement('span');
        wrap.className = segment.cls;
        const first = segment.key === start.key ? Math.min(start.index, segment.words.length) : 0;
        segment.words.slice(first).forEach((word, i) => {
          const index = first + i;
          if (spans.length) wrap.append(' ');
          const span = document.createElement('span');
          span.textContent = word;
          const fresh = index >= (freshFrom.get(segment.key) ?? 0);
          if (fresh) span.className = 'fresh';
          wrap.append(span);
          spans.push({ span, key: segment.key, index, fresh, join: segment.join });
        });
        el.append(wrap);
      }
      if (ghost) el.append(ghost);
      return spans;
    };
    const visible = (span) => span.offsetTop + span.offsetHeight <= el.clientHeight + 1;
    const overflowAt = (spans) => spans.findIndex(({ span }) => !visible(span));
    // Старая страница уходит вверх и гаснет поверх новой, новая проявляется.
    const animateFlip = (oldHtml) => {
      flippedAt = performance.now();
      el.querySelector(':scope > .ghost')?.remove();
      const ghost = document.createElement('div');
      ghost.className = 'ghost';
      ghost.innerHTML = oldHtml;
      ghost.querySelector(':scope > .ghost')?.remove();
      ghost.addEventListener('animationend', () => ghost.remove());
      el.append(ghost);
      el.classList.remove('flip');
      void el.offsetWidth; // перезапуск анимации
      el.classList.add('flip');
      clearTimeout(flipTimer);
      flipTimer = setTimeout(() => el.classList.remove('flip'), 500);
    };
    return {
      reset() {
        start = null; next = null; nextAt = 0; shown = new Map(); el.textContent = '';
        el.classList.remove('flip');
      },
      render(segments) {
        segments = segments.filter((s) => s.words.length);
        next = null;
        nextAt = 0;
        if (!segments.length) return this.reset();
        lastSegments = segments;
        const oldHtml = el.innerHTML;
        // Пропала фраза, с которой начиналась страница (временный хвост) — страница
        // продолжается с последней фразы, а не возвращается к уже прочитанному.
        const hadStart = start && segments.some((s) => s.key === start.key);
        const prevStart = hadStart ? start : null;
        if (!start) start = { key: segments[0].key, index: 0 };
        else if (!hadStart) start = { key: segments.at(-1).key, index: 0 };
        const freshFrom = new Map();
        for (const s of segments) {
          const prev = shown.get(s.key) || [];
          let same = 0;
          while (same < prev.length && same < s.words.length && prev[same] === s.words[same]) same++;
          freshFrom.set(s.key, same);
        }
        // Порядок слова во всём тексте: какая фраза, какое слово в ней.
        const order = ({ key, index }) => segments.findIndex((s) => s.key === key) * 1e6 + index;
        let spans = draw(segments, freshFrom);
        let overflow = overflowAt(spans);
        // Первое появление новой фразы на нижней строке — повод начать её с новой страницы.
        const lastLineTop = el.clientHeight * (lines - 1) / lines - 1;
        const opener = spans.find((s) => s.index === 0 && !s.join && s.key !== start.key &&
          !shown.has(s.key) && s.span.offsetTop >= lastLineTop);
        if (overflow > 0 || opener) {
          // Новая страница начинается с начала фразы, если она влезает, иначе с первого
          // нового слова: слова, пришедшие одним куском с переполнением, не должны
          // пропасть, не показавшись. Без новых слов (повторная отрисовка, другая
          // ширина) страница не листается: недочитанное покажет turn().
          const fresh = spans.find((s) => s.fresh);
          const limit = overflow > 0 ? order(spans[overflow]) : Infinity;
          const candidates = [opener, fresh && { key: fresh.key, index: 0 }, fresh]
            .filter((c) => c && order(c) > order(start) && order(c) <= limit);
          for (const candidate of candidates) {
            start = { key: candidate.key, index: candidate.index };
            spans = draw(segments, freshFrom);
            overflow = overflowAt(spans);
            if (overflow <= 0) break;
          }
        }
        // Новых слов больше, чем страница: показываем их с первого нового слова,
        // остальное — следующими страницами через turn(). Если перед новыми словами
        // ещё есть непоказанные (ждут своей страницы), начало страницы не трогаем.
        if (overflow > 0) {
          const fresh = spans.find((s) => s.fresh);
          if (fresh && order(fresh) > order(start) && order(fresh) <= order(spans[overflow])) {
            start = { key: fresh.key, index: fresh.index };
            spans = draw(segments, freshFrom);
            overflow = overflowAt(spans);
          }
          if (overflow > 0) next = { key: spans[overflow].key, index: spans[overflow].index };
        }
        if (prevStart && !sameWord(prevStart, start)) {
          const wait = flippedAt + minDwellMs - performance.now();
          if (wait > 0) {
            // Страница только что сменилась: следующую покажем чуть позже, а пока
            // новые слова дописываются на текущую (не влезшие — ждут).
            next = start;
            nextAt = performance.now() + wait;
            start = prevStart;
            draw(segments, freshFrom);
          } else {
            animateFlip(oldHtml);
          }
        } else if (!prevStart && oldHtml && start) {
          animateFlip(oldHtml);
        }
        shown = new Map(segments.map((s) => [s.key, s.words]));
      },
      // Перелистывает на следующую страницу недочитанного текста.
      turn() {
        if (!next) return;
        const oldHtml = el.innerHTML;
        start = next;
        next = null;
        nextAt = 0;
        const spans = draw(lastSegments, new Map(lastSegments.map((s) => [s.key, s.words.length])));
        const overflow = overflowAt(spans);
        if (overflow > 0) next = { key: spans[overflow].key, index: spans[overflow].index };
        animateFlip(oldHtml);
      },
      hasMore: () => !!next,
      // Через сколько можно листать: пауза после прошлой смены или время на чтение.
      turnDelay: (msPerWord, minMs) => nextAt ? Math.max(0, nextAt - performance.now()) : Math.max(minMs,
        [...el.querySelectorAll(':scope > span > span')].filter(visible).length * msPerWord),
      startKey: () => start?.key,
    };
  };

  const translationPager = createPager(root.querySelector('.tr'), { lines: TRANSLATION_LINES, minDwellMs: PAGE_DWELL_MS });
  const sourcePager = createPager(root.querySelector('.src'), { lines: 1 });

  let phrases = []; // { id, words, original, final, stale, rewroteAt }
  let carry = null; // { words, until } — хвост после укоротившего финала
  let pageTimer = null;
  let hideTimer = null;
  let pendingDraft = null;
  let draftTimer = null;
  let lastDraftAt = 0;

  const render = () => {
    const last = phrases.at(-1);
    const segments = phrases.map((p) => ({
      key: p.id, words: p.words,
      cls: p.stale ? 'stale' : p !== last ? 'old' : p.final ? '' : 'draft',
    }));
    if (carry && carry.until > performance.now()) segments.push({ key: 'carry', words: carry.words, cls: 'draft', join: true });
    translationPager.render(segments);
    schedulePageTurn();
    // Фразы, целиком ушедшие на прошлые страницы, больше не нужны.
    const first = phrases.findIndex((p) => p.id === translationPager.startKey());
    if (first > 0) phrases = phrases.slice(first);
    sourcePager.render(last ? [{ key: last.id, words: words(last.original), cls: '' }] : []);
  };

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
      ? { left: best.left, width: best.width, bottom: best.bottom - best.height * 0.08 }
      : { left: 0, width: vw, bottom: vh * 0.94 };
    const width = Math.round(Math.min(900, area.width * 0.9, vw * 0.94));
    const fs = Math.round(Math.max(16, Math.min(28, width / 38)));
    const relayout = box.style.width !== `${width}px` || box.style.getPropertyValue('--fs') !== `${fs}px`;
    box.style.setProperty('--fs', `${fs}px`);
    box.style.width = `${width}px`;
    box.style.left = `${area.left + area.width / 2}px`;
    box.style.top = `${Math.min(area.bottom, vh - 8)}px`;
    if (relayout) render(); // другая ширина — другая раскладка страниц
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

  function schedulePageTurn() {
    clearTimeout(pageTimer);
    if (!translationPager.hasMore()) return;
    pageTimer = setTimeout(() => {
      translationPager.turn();
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, HIDE_AFTER_FINAL_MS);
      schedulePageTurn();
    }, translationPager.turnDelay(PAGE_MS_PER_WORD, PAGE_MIN_MS));
  }

  const hide = () => {
    if (translationPager.hasMore()) return; // скроется после последней страницы
    clearTimeout(pageTimer);
    box.classList.add('off');
    clearTimeout(draftTimer);
    draftTimer = null;
    pendingDraft = null;
    phrases = [];
    carry = null;
    translationPager.reset();
    sourcePager.reset();
  };

  const apply = ({ id, translation, original, final }) => {
    let phrase = phrases.find((p) => p.id === id);
    if (!phrase) {
      // Фраза старше показанных уже ушла с экрана: её поздний перевод не нужен.
      if (phrases.some((p) => p.id > id)) return;
      phrase = { id, words: [], original: '', final: false, stale: false, rewroteAt: -Infinity };
      phrases.push(phrase);
      carry = null;
    }
    if (phrase.final && !final) return; // запоздалый черновик после финала
    if (phrase !== phrases.at(-1)) {
      // Поздний перевод уже прочитанной фразы (финал другого движка пришёл после
      // черновика следующей) сдвинул бы все слова после неё. Оставляем как есть.
      phrase.final = phrase.final || !!final;
      return;
    }
    const next = words(translation);
    let same = 0;
    while (same < phrase.words.length && same < next.length && phrase.words[same] === next[same]) same++;
    const rewritten = phrase.words.length - same;
    if (rewritten > REWRITE_TOLERATED_WORDS) {
      if (!final && performance.now() - phrase.rewroteAt < REWRITE_MIN_INTERVAL_MS) return;
      phrase.rewroteAt = performance.now();
    }
    if (final && phrase === phrases.at(-1) && same === next.length && rewritten) {
      carry = { words: phrase.words.slice(same), until: performance.now() + CARRY_MS };
      setTimeout(render, CARRY_MS + 50);
    }
    Object.assign(phrase, { words: next, original: original || '', final: !!final, stale: false });

    if (box.classList.contains('off')) {
      box.classList.remove('off');
      place();
    }
    render();
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
      translationPager.reset();
      hide();
    } else if (message?.type === 'tt-subtitle-stale') {
      const phrase = phrases.find((p) => p.id === message.id);
      if (phrase) { phrase.stale = !!message.stale; render(); }
      if (message.stale && pendingDraft?.id === message.id) pendingDraft = null;
    } else if (message?.type === 'tt-subtitle') {
      receive(message);
    }
  });
})();
