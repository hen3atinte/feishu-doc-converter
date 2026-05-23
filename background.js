// background.js - 服务worker（MV3兼容）
// 注：下载操作在popup.js中直接调用 chrome.downloads API 完成

// 安装/更新时初始化
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[FeishuConverter] 已安装');
  } else if (details.reason === 'update') {
    console.log('[FeishuConverter] 已更新');
  }
});

// 监听来自 popup 的下载请求
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'download_markdown') {
    const { markdown, title } = message;
    const safeName = (title || 'feishu_doc')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .substring(0, 100);
    const filename = safeName + '.md';

    // 使用 data URI 下载（MV3 service worker 中 Blob URL 不可用）
    const dataUri = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(markdown);

    chrome.downloads.download({
      url: dataUri,
      filename: filename,
      saveAs: true,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        // 内容太长？回退到 popup 直接处理
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, filename, downloadId });
      }
    });
    return true; // 异步
  }

  if (message.action === 'get_extension_version') {
    sendResponse({ version: chrome.runtime.getManifest().version });
    return true;
  }
});

// 页面更新时通知 content script
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' &&
      (tab.url?.includes('feishu.cn') || tab.url?.includes('larksuite.com'))) {
    // content script 会自动重新加载，无需手动通知
    console.log('[FeishuConverter] Page loaded:', tab.url);
  }
});
