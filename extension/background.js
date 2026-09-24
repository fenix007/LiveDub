// Нажатие на иконку даёт временный доступ activeTab для tabCapture.
// Открываем панель в том же обработчике, чтобы это было явным вызовом расширения.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  const { keys } = await chrome.storage.local.get('keys');
  if (!keys?.deepgramKey) chrome.runtime.openOptionsPage();
});
