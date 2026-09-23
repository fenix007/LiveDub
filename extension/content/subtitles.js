// Субтитры поверх страницы. Внедряется из боковой панели через chrome.scripting;
// повторное внедрение ничего не делает. Ключей и настроек здесь нет.
(() => {
  if (window.__liveDubSubtitles) return;
  window.__liveDubSubtitles = true;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;left:0;right:0;bottom:9%;z-index:2147483647;' +
    'display:flex;justify-content:center;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .box { max-width: min(880px, 92vw); padding: 8px 14px; border-radius: 10px; text-align: center;
        background: rgba(10, 12, 16, .78); color: #fff; font: 500 22px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        text-shadow: 0 1px 2px rgba(0,0,0,.6); transition: opacity .25s; }
      .box[hidden] { display: block; opacity: 0; }
      .src { font-size: 13px; font-weight: 400; opacity: .7; margin-top: 3px; }
      .draft .tr { opacity: .8; }
    </style>
    <div class="box" hidden><div class="tr"></div><div class="src"></div></div>`;
  const box = root.querySelector('.box');
  let hideTimer = null;

  // В полноэкранном режиме видны только потомки fullscreenElement.
  const mount = () => {
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && !(fullscreen instanceof HTMLVideoElement) ? fullscreen : document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  };
  document.addEventListener('fullscreenchange', mount);
  mount();

  const hide = () => { box.hidden = true; };
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'tt-subtitle-clear') {
      clearTimeout(hideTimer);
      hide();
    } else if (message?.type === 'tt-subtitle') {
      mount();
      root.querySelector('.tr').textContent = message.translation;
      root.querySelector('.src').textContent = message.original || '';
      box.classList.toggle('draft', !message.final);
      box.hidden = false;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, message.final ? 6000 : 12000);
    }
  });
})();
