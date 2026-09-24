// Ключи и настройки хранятся в chrome.storage.local: sync отправил бы ключи
// в аккаунт Google, а content scripts по умолчанию доступа к local не имеют.
export const DEFAULT_KEYS = {
  deepgramKey: '',
  deepseekKey: '',
  deepseekModel: 'deepseek-flash',
  yandexKey: '',
  yandexFolderId: '',
  serverUrl: 'http://localhost:3000', // сервер LiveDub для распознавания Yandex SpeechKit
  serverToken: '',                    // LIVEDUB_STT_TOKEN сервера, если задан
};

export const DEFAULT_PREFS = {
  source: 'en',
  sttEngine: 'deepgram',   // deepgram | yandex (через сервер LiveDub)
  target: 'ru',
  draftEngine: 'chrome',   // chrome | yandex | deepseek | off
  finalEngine: 'yandex',   // yandex | deepseek | chrome
  tts: false,
  ttsProvider: 'browser',  // browser | yandex
  voice: '',
  subtitles: true,
  duck: 0.3,               // громкость оригинала во время озвучки
  endpointing: 300,        // мс тишины, после которых Deepgram закрывает фразу
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
