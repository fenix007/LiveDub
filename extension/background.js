// Клик по иконке открывает боковую панель. Этот же клик даёт activeTab,
// без которого chrome.tabCapture не выдаст поток вкладки.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  const { keys } = await chrome.storage.local.get('keys');
  if (!keys?.deepgramKey) chrome.runtime.openOptionsPage();
});
