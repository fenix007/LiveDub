// Ключи и настройки хранятся в chrome.storage.local: sync отправил бы ключи
// в аккаунт Google, а content scripts по умолчанию доступа к local не имеют.
export const DEFAULT_KEYS = {
  deepgramKey: '',
  deepseekKey: '',
  deepseekModel: 'deepseek-flash',
  yandexKey: '',
  yandexFolderId: '',
};

export const DEFAULT_PREFS = {
  source: 'en',
  target: 'ru',
  draftEngine: 'chrome',   // chrome | yandex | deepseek | off
  finalEngine: 'yandex',   // yandex | deepseek | chrome
  tts: false,
  ttsProvider: 'browser',  // browser | yandex
  voice: '',
  subtitles: true,
  duck: 0.3,               // громкость оригинала во время озвучки
};

export async function loadKeys() {
  const { keys } = await chrome.storage.local.get('keys');
  return { ...DEFAULT_KEYS, ...keys };
}

export async function saveKeys(keys) {
  const clean = Object.fromEntries(Object.keys(DEFAULT_KEYS)
    .map((name) => [name, String(keys[name] ?? '').trim() || DEFAULT_KEYS[name]]));
  await chrome.storage.local.set({ keys: clean });
  return clean;
}

export async function loadPrefs() {
  const { prefs } = await chrome.storage.local.get('prefs');
  return { ...DEFAULT_PREFS, ...prefs };
}

export const savePrefs = (prefs) => chrome.storage.local.set({ prefs });
