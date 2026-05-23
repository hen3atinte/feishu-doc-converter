// popup.js - 飞书文档转换器弹出窗口逻辑
(function () {
  const btnConvert = document.getElementById('btnConvert');
  const btnDownload = document.getElementById('btnDownload');
  const btnCopy = document.getElementById('btnCopy');
  const btnPreview = document.getElementById('btnPreview');
  const statusEl = document.getElementById('status');
  const docTitleEl = document.getElementById('docTitle');
  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const statsEl = document.getElementById('stats');
  const previewEl = document.getElementById('preview');

  let currentMarkdown = '';
  let currentTitle = '';
  let currentTab = null;

  // 显示状态
  function showStatus(msg, type = 'loading') {
    statusEl.textContent = msg;
    statusEl.className = `status show ${type}`;
  }

  function setProgress(pct) {
    progressWrap.className = 'progress-wrap show';
    progressFill.style.width = pct + '%';
  }

  function setStats(lines, chars) {
    statsEl.textContent = `📊 ${lines} 行 · ${chars.toLocaleString()} 字符`;
  }

  // 获取当前标签页
  async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  // 检测是否在飞书文档页面
  function isFeishuDoc(url) {
    return /feishu\.cn|(?:larksuite\.com)/i.test(url || '');
  }

  // 初始化
  async function init() {
    const tab = await getCurrentTab();
    currentTab = tab;

    if (!tab || !isFeishuDoc(tab.url)) {
      docTitleEl.textContent = '⚠️ 请打开飞书文档页面';
      btnConvert.disabled = true;
      return;
    }

    // 尝试从页面获取标题
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.title || '',
      });
      const title = results?.[0]?.result || '未命名文档';
      docTitleEl.textContent = `📄 ${title}`;
    } catch (e) {
      docTitleEl.textContent = '📄 文档（请刷新页面重试）';
    }

    btnConvert.disabled = false;
  }

  // 发送转换请求
  async function requestConvert() {
    if (!currentTab) return;

    showStatus('⏳ 正在提取文档内容...', 'loading');
    setProgress(10);
    btnConvert.disabled = true;
    btnDownload.disabled = true;
    btnCopy.disabled = true;

    const options = {
      tables: document.getElementById('optTables').checked,
      images: document.getElementById('optImages').checked,
      links: document.getElementById('optLinks').checked,
      debug: document.getElementById('optDebug').checked,
    };

    try {
      const response = await chrome.tabs.sendMessage(currentTab.id, {
        action: 'convert_doc',
        options,
      });

      if (!response) {
        showStatus('❌ 页面无响应，请刷新后重试', 'error');
        btnConvert.disabled = false;
        return;
      }

      if (response.error) {
        showStatus(`❌ ${response.error}`, 'error');
        btnConvert.disabled = false;
        return;
      }

      currentMarkdown = response.markdown || '';
      currentTitle = response.title || '';

      const lines = (currentMarkdown.match(/\n/g) || []).length + 1;
      const chars = currentMarkdown.length;

      setProgress(100);
      showStatus('✅ 转换完成！', 'success');
      setStats(lines, chars);

      btnCopy.disabled = false;
      btnDownload.className = 'btn btn-success';
      btnDownload.textContent = '💾 下载 .md';
      btnDownload.disabled = false;

      // 保存到 storage
      chrome.storage.local.set({ lastMarkdown: currentMarkdown, lastTitle: currentTitle });

    } catch (e) {
      showStatus(`❌ 转换失败: ${e.message}`, 'error');
    }

    btnConvert.disabled = false;
  }

  // 下载 Markdown 文件
  async function downloadMarkdown() {
    if (!currentMarkdown) return;

    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'download_markdown',
        markdown: currentMarkdown,
        title: currentTitle,
      });

      if (resp?.success) {
        showStatus(`✅ 已保存: ${resp.filename}`, 'success');
      } else {
        // fallback: 使用 blob URL 下载
        const blob = new Blob([currentMarkdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        await chrome.downloads.download({
          url,
          filename: (currentTitle || 'feishu_doc').replace(/[\\/:*?"<>|]/g, '_') + '.md',
          saveAs: true,
        });
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        showStatus('✅ 下载已开始', 'success');
      }
    } catch (e) {
      showStatus(`❌ 下载失败: ${e.message}`, 'error');
    }
  }

  // 复制到剪贴板
  async function copyToClipboard() {
    if (!currentMarkdown) return;
    try {
      await navigator.clipboard.writeText(currentMarkdown);
      showStatus('✅ 已复制到剪贴板', 'success');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = currentMarkdown;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showStatus('✅ 已复制到剪贴板', 'success');
    }
  }

  // 预览切换
  function togglePreview() {
    if (!currentMarkdown) {
      showStatus('⚠️ 请先执行转换', 'error');
      return;
    }
    if (previewEl.classList.contains('show')) {
      previewEl.classList.remove('show');
      btnPreview.textContent = '👁 预览';
    } else {
      previewEl.textContent = currentMarkdown.substring(0, 5000) +
        (currentMarkdown.length > 5000 ? '\n\n... (内容已截断) ...' : '');
      previewEl.classList.add('show');
      btnPreview.textContent = '👁 隐藏预览';
    }
  }

  // 事件绑定
  btnConvert.addEventListener('click', requestConvert);
  btnDownload.addEventListener('click', downloadMarkdown);
  btnCopy.addEventListener('click', copyToClipboard);
  btnPreview.addEventListener('click', togglePreview);

  // 恢复上次转换结果
  chrome.storage.local.get(['lastMarkdown', 'lastTitle'], (data) => {
    if (data.lastMarkdown) {
      currentMarkdown = data.lastMarkdown;
      currentTitle = data.lastTitle || '';
      btnCopy.disabled = false;
      btnDownload.disabled = false;
      btnDownload.className = 'btn btn-success';
      btnDownload.textContent = '💾 下载 .md';
    }
  });

  // 初始化
  init();
})();
