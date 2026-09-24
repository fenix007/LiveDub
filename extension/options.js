import { DEFAULT_KEYS, loadKeys, saveKeys } from './lib/settings.js';
import { checkDeepgram, checkDeepSeek, checkServer, checkYandex } from './lib/providers.js';

const $ = (id) => document.getElementById(id);
const fields = Object.keys(DEFAULT_KEYS);
const values = () => Object.fromEntries(fields.map((name) => [name, $(name).value.trim()]));

const keys = await loadKeys();
for (const name of fields) $(name).value = keys[name];

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const saved = await saveKeys(values());
  $('deepseekModel').value = saved.deepseekModel;
  $('saved').textContent = 'Сохранено';
  $('saved').className = 'result ok';
});

const checks = {
  deepgram: ({ deepgramKey }) => checkDeepgram(deepgramKey),
  deepseek: ({ deepseekKey, deepseekModel }) => checkDeepSeek(deepseekKey, deepseekModel || DEFAULT_KEYS.deepseekModel),
  yandex: ({ yandexKey, yandexFolderId }) => checkYandex(yandexKey, yandexFolderId),
  server: ({ serverUrl, serverToken }) => checkServer(serverUrl || DEFAULT_KEYS.serverUrl, serverToken),
};
const required = { deepgram: 'deepgramKey', deepseek: 'deepseekKey', yandex: 'yandexKey' };

for (const button of document.querySelectorAll('[data-check]')) {
  button.addEventListener('click', async () => {
    const name = button.dataset.check;
    const result = document.querySelector(`[data-result="${name}"]`);
    const current = values();
    if (required[name] && !current[required[name]]) {
      result.textContent = 'Введите ключ';
      result.className = 'result err';
      return;
    }
    button.disabled = true;
    result.textContent = 'проверяю…';
    result.className = 'result';
    try {
      const message = await checks[name](current);
      result.textContent = message;
      result.className = /не принят|нет нужных|HTTP|недоступен|нет в списке/.test(message) ? 'result err' : 'result ok';
    } catch (error) {
      result.textContent = error.name === 'TimeoutError' ? 'таймаут запроса' : error.message;
      result.className = 'result err';
    } finally {
      button.disabled = false;
    }
  });
}
