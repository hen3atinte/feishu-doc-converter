// ============================================================
// 飞书文档转换器 - Popup Script (v2.8)
// 功能：Tab切换、URL粘贴导航、后台持久转换、XSS安全DOCX、ZIP下载、历史
// v2.8 修复：list_active_tasks空指针保护（resp?.tasks?.length）
// 修复：活跃任务恢复、localStorage溢出、DOCX URL协议白名单、HTML实体保护
// v2.4 新增：DOCX h5/h6支持、CSS ol/ul样式、tab监听器内存泄漏修复、版本号同步
// v2.5 新增：DOCX URL &amp; 还原、unload→pagehide
// v2.6 新增：ZIP replaceAll全局替换、DOCX空行可见化、page超限告警
// v2.7 新增：DOCX块级间距优化、恢复历史预览同步、ZIP失败URL报告
// ============================================================

(function () {
  'use strict';

  // ---- 状态 ----
  let currentMarkdown = '';
  let currentTitle = 'untitled';
  let currentImageUrls = [];
  let currentTaskId = null;
  let pollTimer = null;

  // ---- DOM 引用 ----
  const $ = (id) => document.getElementById(id);
  const el = {
    // 转换 Tab
    urlInput: $('urlInput'),
    btnUrlGo: $('btnUrlGo'),
    btnConvert: $('btnConvert'),
    btnDownload: $('btnDownload'),
    btnZip: $('btnZip'),
    btnDocx: $('btnDocx'),
    btnCopy: $('btnCopy'),
    btnPreview: $('btnPreview'),
    docTitle: $('docTitle'),
    docUrl: $('docUrl'),
    status: $('status'),
    progressWrap: $('progressWrap'),
    progressFill: $('progressFill'),
    stats: $('stats'),
    preview: $('preview'),
    optTables: $('optTables'),
    optImages: $('optImages'),
    optLinks: $('optLinks'),
    optDebug: $('optDebug'),
    // 历史 Tab
    historyList: $('historyList'),
    tabConvert: $('tabConvert'),
    tabHistory: $('tabHistory'),
  };

  // ---- Tab 切换 ----
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      // 切换 tab 样式
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      // 切换内容
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      if (target === 'convert') {
        el.tabConvert.classList.add('active');
      } else if (target === 'history') {
        el.tabHistory.classList.add('active');
        renderHistory();
      }
    });
  });

  // ---- 工具函数 ----
  function showStatus(msg, type = 'loading') {
    el.status.textContent = msg;
    el.status.className = `status show ${type}`;
  }

  function hideStatus() {
    el.status.className = 'status';
  }

  function setProgress(pct, text = '') {
    el.progressWrap.classList.add('show');
    el.progressFill.style.width = `${pct}%`;
    if (text) el.stats.textContent = text;
  }

  function hideProgress() {
    el.progressWrap.classList.remove('show');
    el.progressFill.style.width = '0%';
    el.stats.textContent = '';
  }

  function enableButtons(hasResult) {
    el.btnDownload.disabled = !hasResult;
    el.btnZip.disabled = !hasResult || currentImageUrls.length === 0;
    el.btnDocx.disabled = !hasResult;
    el.btnCopy.disabled = !hasResult;
  }

  // ---- HTML 实体转义（XSS 防护） ----
  function escapeHtml(str) {
    // 保护已有的 HTML 实体不被二次转义（&amp; → &amp;amp;）
    return String(str)
      .replace(/&(?!(?:amp|lt|gt|quot|#39|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---- URL 解析（popup 侧，用于粘贴的 URL） ----
  function parsePastedUrl(url) {
    const hostMatch = url.match(/https?:\/\/([^\/]+)/);
    if (!hostMatch) return null;
    const host = hostMatch[1];
    const isFeishu = /\.feishu\.cn$/.test(host) || /\.larksuite\.com$/.test(host);
    if (!isFeishu) return null;

    const patterns = [
      { regex: /\/wiki\/([A-Za-z0-9_-]+)/, type: 'wiki' },
      { regex: /\/docx\/([A-Za-z0-9_-]+)/, type: 'docx' },
      { regex: /\/docs\/([A-Za-z0-9_-]+)/, type: 'docs' },
      { regex: /\/mindnotes\/([A-Za-z0-9_-]+)/, type: 'mindnote' },
      { regex: /\/sheets\/([A-Za-z0-9_-]+)/, type: 'sheet' },
      { regex: /\/space\/([A-Za-z0-9_-]+)/, type: 'space' },
      { regex: /\/base\/([A-Za-z0-9_-]+)/, type: 'bitable' },
    ];

    for (const p of patterns) {
      const match = url.match(p.regex);
      if (match) {
        return { type: p.type, token: match[1], host, url };
      }
    }
    return null;
  }

  // ---- 检测当前 tab 文档信息 ----
  async function detectDoc() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        el.docTitle.textContent = '⚠ 无法获取当前标签页';
        el.btnConvert.disabled = true;
        return;
      }

      const resp = await chrome.tabs.sendMessage(tab.id, { action: 'get_doc_info' });
      if (resp && resp.token) {
        el.docTitle.textContent = resp.title || 'untitled';
        el.docUrl.textContent = resp.url || '';
        el.docUrl.style.display = 'block';
        el.btnConvert.disabled = false;
        // 预填 URL 输入框
        if (!el.urlInput.value) {
          el.urlInput.value = resp.url || '';
        }
        return { tabId: tab.id, info: resp };
      } else {
        el.docTitle.textContent = resp?.error || '⚠ 非飞书文档页面';
        el.btnConvert.disabled = true;
        return null;
      }
    } catch (err) {
      el.docTitle.textContent = '⚠ 当前页面不支持（需刷新后重试）';
      el.btnConvert.disabled = true;
      return null;
    }
  }

  // ---- URL 粘贴 → 导航到文档 ----
  async function navigateToUrl(url) {
    const parsed = parsePastedUrl(url);
    if (!parsed) {
      showStatus('❌ 无效的飞书文档链接', 'error');
      return false;
    }

    if (parsed.type === 'mindnote' || parsed.type === 'sheet' || parsed.type === 'bitable') {
      showStatus(`⚠ ${parsed.type} 类型暂不支持 API 解析，仅支持 wiki/docx/docs/space`, 'error');
      return false;
    }

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return false;

      showStatus('🔄 正在打开文档...', 'loading');
      await chrome.tabs.update(tab.id, { url: parsed.url });

    // 等待页面加载完成
      await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn) => {
          if (settled) return;
          settled = true;
          chrome.tabs.onUpdated.removeListener(listener);
          fn();
        };

        const listener = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            settle(resolve);
          }
        };
        chrome.tabs.onUpdated.addListener(listener);

        // 超时 15s — 无论何种原因（含 chrome.tabs.update 失败）都清理监听器
        setTimeout(() => settle(() => reject(new Error('页面加载超时'))), 15000);
      });

      // 等待 content script 注入
      await new Promise(r => setTimeout(r, 1000));

      hideStatus();
      await detectDoc();
      return true;
    } catch (err) {
      showStatus(`❌ 导航失败: ${err.message}`, 'error');
      return false;
    }
  }

  // ---- 核心转换（通过 background.js 持久化） ----
  async function requestConvert() {
    el.btnConvert.disabled = true;
    el.btnConvert.textContent = '⏳ 准备...';
    hideStatus();
    hideProgress();

    const docCtx = await detectDoc();
    if (!docCtx) {
      el.btnConvert.textContent = '🔄 开始转换';
      el.btnConvert.disabled = false;
      return;
    }

    const options = {
      tables: el.optTables.checked,
      images: el.optImages.checked,
      links: el.optLinks.checked,
      debug: el.optDebug.checked,
    };

    try {
      // 发送给 background.js（持久转换，关闭 popup 不中断）
      const resp = await chrome.runtime.sendMessage({
        action: 'start_conversion',
        tabId: docCtx.tabId,
        options,
      });

      currentTaskId = resp.taskId;
      el.btnConvert.textContent = '⏳ 转换中...';
      showStatus('⏳ 正在转换（后台运行，可关闭此窗口）...', 'loading');
      setProgress(10, '已提交后台任务');

      // 轮询结果
      await pollConversion();
    } catch (err) {
      showStatus(`❌ ${err.message}`, 'error');
      el.btnConvert.textContent = '🔄 重试';
      el.btnConvert.disabled = false;
      hideProgress();
    }
  }

  async function pollConversion() {
    if (pollTimer) clearInterval(pollTimer);

    const maxPolls = 120; // 最多轮询 2 分钟
    let polls = 0;
    let lastProgress = 10;

    return new Promise((resolve, reject) => {
      pollTimer = setInterval(async () => {
        polls++;
        if (polls > maxPolls) {
          clearInterval(pollTimer);
          pollTimer = null;
          showStatus('❌ 转换超时', 'error');
          el.btnConvert.textContent = '🔄 重试';
          el.btnConvert.disabled = false;
          hideProgress();
          reject(new Error('转换超时'));
          return;
        }

        // 动画进度
        lastProgress = Math.min(lastProgress + 0.5, 90);
        setProgress(lastProgress, `轮询中... (${polls}s)`);

        try {
          const resp = await chrome.runtime.sendMessage({
            action: 'get_status',
            taskId: currentTaskId,
          });

          if (resp.status === 'done') {
            clearInterval(pollTimer);
            pollTimer = null;
            currentMarkdown = resp.result.markdown;
            currentTitle = resp.result.title;
            currentImageUrls = resp.result.imageUrls || [];

            setProgress(100, `✅ 完成 | ${currentTitle} | ${(currentMarkdown.length / 1024).toFixed(1)} KB | ${currentImageUrls.length} 张图${resp.result.truncated ? ' (已达页数上限)' : ''}`);
            enableButtons(true);
            el.btnConvert.textContent = '🔄 再次转换';
            el.btnConvert.disabled = false;

            if (resp.result.unresolvedRefs > 0) {
              showStatus(`⚠ 有 ${resp.result.unresolvedRefs} 处跨页引用未能解析`, 'error');
            } else {
              showStatus(`✅ 转换完成 — ${(currentMarkdown.length / 1024).toFixed(1)} KB，${currentImageUrls.length} 张图片`, 'success');
            }

            saveToHistory();
            resolve();
          } else if (resp.status === 'error') {
            clearInterval(pollTimer);
            pollTimer = null;
            showStatus(`❌ ${resp.error}`, 'error');
            el.btnConvert.textContent = '🔄 重试';
            el.btnConvert.disabled = false;
            hideProgress();
            reject(new Error(resp.error));
          }
        } catch (err) {
          // background 可能已重启，忽略单次失败
        }
      }, 1000);
    });
  }

  // ---- 下载 Markdown ----
  function downloadMarkdown() {
    if (!currentMarkdown) return;
    const filename = `${currentTitle}.md`;
    chrome.runtime.sendMessage({
      action: 'download_file',
      filename,
      content: currentMarkdown,
      mimeType: 'text/markdown',
    }).catch(() => {
      // 回退：popup 内下载
      const blob = new Blob([currentMarkdown], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  // ---- 图片下载 + ZIP 打包 ----
  async function downloadImagesZip() {
    if (!currentMarkdown || currentImageUrls.length === 0) {
      showStatus('⚠ 没有可下载的图片', 'error');
      return;
    }

    el.btnZip.disabled = true;
    el.btnZip.textContent = '⏳ 下载中...';
    showStatus(`⏳ 正在下载 ${currentImageUrls.length} 张图片...`, 'loading');

    try {
      // 使用 JSZip（已在 popup.html 中引入）
      const zip = new JSZip();
      const imgFolder = zip.folder('images');
      let downloaded = 0;
      const failedUrls = [];
      let markdown = currentMarkdown;

      const maxConcurrent = 5;
      const urlList = [...currentImageUrls];

      // 分批并发下载
      for (let i = 0; i < urlList.length; i += maxConcurrent) {
        const batch = urlList.slice(i, i + maxConcurrent);
        const results = await Promise.allSettled(
          batch.map(async (img, idx) => {
            try {
              const resp = await fetch(img.url, { mode: 'cors' });
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const blob = await resp.blob();

              // 确定扩展名
              const contentType = resp.headers.get('content-type') || '';
              let ext = 'png';
              if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = 'jpg';
              else if (contentType.includes('gif')) ext = 'gif';
              else if (contentType.includes('svg')) ext = 'svg';
              else if (contentType.includes('webp')) ext = 'webp';

              const filename = `img_${String(i + idx).padStart(3, '0')}.${ext}`;
              imgFolder.file(filename, blob);

              // 替换 Markdown 中的所有该远程 URL 为本地路径（split+join 安全替换，不受 regex 特殊字符影响）
              markdown = markdown.split(img.url).join(`images/${filename}`);

              return { success: true, filename };
            } catch (err) {
              return { success: false, url: img.url, error: err.message };
            }
          })
        );

        for (const r of results) {
          if (r.status === 'fulfilled' && r.value?.success) {
            downloaded++;
          } else if (r.status === 'fulfilled') {
            failedUrls.push(r.value?.url || 'unknown');
          } else {
            failedUrls.push('(网络错误)');
          }
        }

        setProgress(
          Math.round((i + batch.length) / urlList.length * 100),
          `已下载 ${downloaded}/${urlList.length}`
        );
      }

      // 更新 Markdown 并添加到 ZIP
      zip.file(`${currentTitle}.md`, markdown);

      // 生成 ZIP
      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      // 下载 ZIP
      const zipUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = zipUrl;
      a.download = `${currentTitle}_with_images.zip`;
      a.click();
      URL.revokeObjectURL(zipUrl);

      currentMarkdown = markdown; // 更新为本地路径版本
      if (downloaded === 0) {
        showStatus(`❌ ZIP 打包失败: 所有 ${urlList.length} 张图片下载失败`, 'error');
      } else if (failedUrls.length > 0) {
        showStatus(`✅ ZIP 打包完成 — ${downloaded}/${urlList.length} 张 (${failedUrls.length} 张失败)`, 'success');
      } else {
        showStatus(`✅ ZIP 打包完成 — ${downloaded}/${urlList.length} 张图片`, 'success');
      }
    } catch (err) {
      showStatus(`❌ ZIP 打包失败: ${err.message}`, 'error');
    } finally {
      el.btnZip.textContent = '📦 图片+ZIP';
      el.btnZip.disabled = false;
      hideProgress();
    }
  }

  // ---- DOCX 导出（XSS 安全） ----
  function sanitizeUrl(rawUrl) {
    // 只允许安全协议：http/https/ftp/mailto/相对路径/数据图片
    const trimmed = rawUrl.trim();
    if (!trimmed) return '#';

    // 相对路径或锚点：安全
    if (/^[#\/]/.test(trimmed)) return trimmed;

    // 数据 URI：只允许安全图片类型（排除 SVG 等可执行格式）
    if (/^data:image\/(png|jpeg|gif|webp|bmp|tiff);/i.test(trimmed)) return trimmed;

    // 检查协议
    const protocolMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):/);
    if (protocolMatch) {
      const protocol = protocolMatch[1].toLowerCase();
      const allowed = ['http', 'https', 'ftp', 'mailto'];
      if (!allowed.includes(protocol)) return '#'; // 危险协议，替换为无害锚点
    }

    return trimmed;
  }

  function exportDocx() {
    if (!currentMarkdown) return;

    // XSS 防护：对所有 Markdown 内容做 HTML 实体转义
    const safeMd = escapeHtml(currentMarkdown);

    // 简单 Markdown → HTML 转换（在转义后进行，用安全的方式重建）
    // 先转换列表行，然后合并相邻同类列表项
    let html = safeMd
      // 标题（h1-h6 全部支持）
      .replace(/^###### (.+)$/gm, '<h6>$1</h6>')
      .replace(/^##### (.+)$/gm, '<h5>$1</h5>')
      .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      // 粗体/斜体
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // 行内代码
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // 代码块
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      // 图片（过滤危险 URL 协议，还原 &amp; 转义）
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
        return `<img src="${sanitizeUrl(url).replace(/&amp;/g, '&')}" alt="${alt}">`;
      })
      // 链接（过滤危险 URL 协议，还原 &amp; 转义）
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
        return `<a href="${sanitizeUrl(url).replace(/&amp;/g, '&')}">${text}</a>`;
      })
      // 分割线
      .replace(/^---$/gm, '<hr>')
      // 引用（转义后 > 变成 &gt;）
      .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
      // 有序列表（数字.开头）→ 临时标记
      .replace(/^\d+\. (.+)$/gm, '<__ol__>$1</__ol__>')
      // 无序列表（-开头）
      .replace(/^- (.+)$/gm, '<__ul__>$1</__ul__>')
      // 段落（非HTML标签行）
      .replace(/^(?!<[a-z_/])(.+)$/gm, '<p>$1</p>');

    // 合并相邻 ol 列表项
    html = html.replace(/(<__ol__>[\s\S]*?<\/__ol__>)(\n<__ol__>[\s\S]*?<\/__ol__>)*/g, (m) => {
      const items = m.replace(/<__ol__>([\s\S]*?)<\/__ol__>/g, '<li>$1</li>');
      return `<ol>${items}</ol>`;
    });
    // 合并相邻 ul 列表项
    html = html.replace(/(<__ul__>[\s\S]*?<\/__ul__>)(\n<__ul__>[\s\S]*?<\/__ul__>)*/g, (m) => {
      const items = m.replace(/<__ul__>([\s\S]*?)<\/__ul__>/g, '<li>$1</li>');
      return `<ul>${items}</ul>`;
    });

    // 连续空行 → 可见换行（HTML 中 \n 不产生视觉间距）
    html = html.replace(/\n\n+/g, '<br><br>');
    html = html.replace(/\n/g, '');
    // 移除块级元素间多余的 <br>（p/h1-h6/li 等已有 CSS margin）
    html = html.replace(/<\/(p|h[1-6]|li|ol|ul|blockquote|pre|hr)><br><br><([a-z])/g, '</$1><$2');

    const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(currentTitle)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 800px; margin: 40px auto; padding: 20px;
      line-height: 1.8; color: #333;
    }
    h1 { font-size: 24px; border-bottom: 2px solid #eee; padding-bottom: 8px; }
    h2 { font-size: 20px; margin-top: 24px; }
    h3 { font-size: 17px; margin-top: 20px; }
    h4 { font-size: 15px; margin-top: 16px; }
    h5 { font-size: 13px; margin-top: 14px; color: #555; }
    h6 { font-size: 12px; margin-top: 12px; color: #777; font-style: italic; }
    p { margin: 8px 0; }
    ol, ul { margin: 8px 0 8px 24px; padding: 0; }
    li { margin: 4px 0; line-height: 1.6; }
    ol li { list-style-type: decimal; }
    ul li { list-style-type: disc; }
    code {
      background: #f5f5f5; padding: 2px 6px; border-radius: 3px;
      font-family: "SF Mono", Consolas, monospace; font-size: 13px;
    }
    pre {
      background: #f5f5f5; padding: 12px 16px; border-radius: 6px;
      overflow-x: auto;
    }
    pre code { background: none; padding: 0; }
    blockquote {
      border-left: 3px solid #4A6CF7; padding: 4px 12px;
      margin: 8px 0; color: #666; background: #f8f9ff;
    }
    img { max-width: 100%; height: auto; border-radius: 4px; }
    hr { border: none; border-top: 1px solid #eee; margin: 16px 0; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
    th { background: #f5f5f5; }
  </style>
</head>
<body>
${html}
</body>
</html>`;

    const blob = new Blob(['\ufeff' + fullHtml], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentTitle}.doc`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- 复制到剪贴板 ----
  async function copyToClipboard() {
    if (!currentMarkdown) return;
    try {
      await navigator.clipboard.writeText(currentMarkdown);
      showStatus('✅ 已复制到剪贴板', 'success');
      setTimeout(hideStatus, 2000);
    } catch (err) {
      showStatus('❌ 复制失败，请尝试重新选择文本', 'error');
    }
  }

  // ---- 预览 ----
  function togglePreview() {
    if (!currentMarkdown) return;
    const isShown = el.preview.classList.contains('show');
    if (isShown) {
      el.preview.classList.remove('show');
      el.btnPreview.textContent = '👁 预览';
    } else {
      el.preview.textContent = currentMarkdown.slice(0, 8000) +
        (currentMarkdown.length > 8000 ? '\n\n... (内容过长，仅显示前 8000 字符)' : '');
      el.preview.classList.add('show');
      el.btnPreview.textContent = '🙈 隐藏';
    }
  }

  // ---- 历史记录（元数据存 localStorage，内容存 chrome.storage.local） ----
  const HISTORY_META_KEY = 'feishu_conv_history_meta';
  const HISTORY_CONTENT_PREFIX = 'history_content_';

  function loadHistoryMeta() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_META_KEY) || '[]');
    } catch {
      return [];
    }
  }

  function saveHistoryMeta(meta) {
    localStorage.setItem(HISTORY_META_KEY, JSON.stringify(meta));
  }

  async function saveToHistory() {
    if (!currentMarkdown || !currentTitle) return;
    const meta = loadHistoryMeta();

    // 去重
    const existing = meta.findIndex(h => h.title === currentTitle);
    if (existing >= 0) meta.splice(existing, 1);

    const size = currentMarkdown.length;
    const entry = {
      title: currentTitle,
      imageCount: currentImageUrls.length,
      date: new Date().toLocaleString('zh-CN'),
      size,
      contentKey: HISTORY_CONTENT_PREFIX + encodeURIComponent(currentTitle),
    };

    meta.unshift(entry);

    // 保留最近 20 条
    const trimmed = meta.slice(0, 20);
    saveHistoryMeta(trimmed);

    // 清理超出20条的内容，并将当前内容存入 chrome.storage.local
    const keysToKeep = new Set(trimmed.map(h => h.contentKey));
    const allStorage = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(allStorage).filter(
      k => k.startsWith(HISTORY_CONTENT_PREFIX) && !keysToKeep.has(k)
    );
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }
    await chrome.storage.local.set({
      [entry.contentKey]: {
        markdown: currentMarkdown,
        imageUrls: currentImageUrls,
      },
    });
  }

  function renderHistory() {
    const meta = loadHistoryMeta();
    if (meta.length === 0) {
      el.historyList.innerHTML = '<div style="text-align:center;color:#888;padding:20px;font-size:13px;">暂无历史记录</div>';
      return;
    }

    el.historyList.innerHTML = meta.map((h, i) => `
      <div class="history-item" data-idx="${i}">
        <span class="h-title" title="${escapeHtml(h.title)}">${escapeHtml(h.title)}</span>
        <span class="h-meta">${(h.size / 1024).toFixed(1)} KB · ${h.date}</span>
        <span class="h-del" data-idx="${i}">×</span>
      </div>
    `).join('');

    // 点击历史项 → 恢复
    el.historyList.querySelectorAll('.h-title').forEach(item => {
      item.addEventListener('click', (e) => {
        const idx = parseInt(e.target.closest('.history-item').dataset.idx);
        restoreFromHistory(idx);
      });
    });

    // 点击删除
    el.historyList.querySelectorAll('.h-del').forEach(del => {
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(e.target.dataset.idx);
        deleteHistory(idx);
      });
    });
  }

  async function restoreFromHistory(idx) {
    const meta = loadHistoryMeta();
    if (idx < 0 || idx >= meta.length) return;
    const h = meta[idx];

    try {
      const data = await chrome.storage.local.get(h.contentKey);
      const content = data[h.contentKey];
      if (!content) {
        showStatus('⚠ 历史内容已过期', 'error');
        return;
      }
      currentMarkdown = content.markdown;
      currentTitle = h.title;
      currentImageUrls = content.imageUrls || [];
      enableButtons(true);
      // 如果预览正在显示，刷新内容（否则显示的仍是旧文档）
      if (el.preview.classList.contains('show')) {
        el.preview.textContent = currentMarkdown.slice(0, 8000) +
          (currentMarkdown.length > 8000 ? '\n\n... (内容过长，仅显示前 8000 字符)' : '');
      }
      showStatus(`✅ 已恢复: ${h.title} (${(h.size / 1024).toFixed(1)} KB)`, 'success');
    } catch (e) {
      showStatus('⚠ 恢复失败: ' + e.message, 'error');
      return;
    }

    // 切换到转换 Tab
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.tab[data-tab="convert"]').classList.add('active');
    el.tabConvert.classList.add('active');
    el.tabHistory.classList.remove('active');
  }

  async function deleteHistory(idx) {
    const meta = loadHistoryMeta();
    if (idx < 0 || idx >= meta.length) return;
    const removed = meta.splice(idx, 1);
    saveHistoryMeta(meta);

    // 清理对应的 chrome.storage.local 内容
    if (removed.length > 0) {
      await chrome.storage.local.remove(removed[0].contentKey);
    }

    renderHistory();
  }

  // ---- 事件绑定 ----
  el.btnConvert.addEventListener('click', requestConvert);
  el.btnDownload.addEventListener('click', downloadMarkdown);
  el.btnZip.addEventListener('click', downloadImagesZip);
  el.btnDocx.addEventListener('click', exportDocx);
  el.btnCopy.addEventListener('click', copyToClipboard);
  el.btnPreview.addEventListener('click', togglePreview);

  el.btnUrlGo.addEventListener('click', async () => {
    const url = el.urlInput.value.trim();
    if (!url) {
      showStatus('⚠ 请粘贴飞书文档链接', 'error');
      return;
    }
    el.btnUrlGo.disabled = true;
    el.btnUrlGo.textContent = '⏳';
    await navigateToUrl(url);
    el.btnUrlGo.textContent = '打开';
    el.btnUrlGo.disabled = false;
  });

  // Enter 键触发 URL 导航
  el.urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      el.btnUrlGo.click();
    }
  });

  // ---- 初始化 ----
  (async function init() {
    // 检查是否有活跃的后台转换任务
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'list_active_tasks' });
      if (resp?.tasks?.length > 0) {
        // 有活跃任务，恢复轮询
        const activeTask = resp.tasks[0]; // 取第一个活跃任务
        currentTaskId = activeTask.id;
        el.btnConvert.textContent = '⏳ 恢复转换...';
        el.btnConvert.disabled = true;
        showStatus('⏳ 检测到后台转换任务，正在恢复...', 'loading');
        setProgress(10, '恢复后台任务');
        try {
          await pollConversion();
        } catch (e) {
          // pollConversion 内部会处理错误显示
        }
      }
    } catch (e) {
      // background 不可用，忽略
    }

    // 恢复上次结果（从 chrome.storage.local）
    try {
      const last = await chrome.storage.local.get(['lastMarkdown', 'lastTitle', 'lastImageUrls']);
      if (last.lastMarkdown) {
        currentMarkdown = last.lastMarkdown;
        currentTitle = last.lastTitle || 'untitled';
        currentImageUrls = last.lastImageUrls || [];
        enableButtons(true);
        if (!currentTaskId) {
          showStatus(`📦 已恢复上次转换结果: ${currentTitle}`, 'success');
          setTimeout(hideStatus, 3000);
        }
      }
    } catch (e) {
      // ignore
    }

    await detectDoc();
  })();

  // 关闭 popup 前保存状态（pagehide 比 unload 更可靠）
  window.addEventListener('pagehide', () => {
    if (currentMarkdown) {
      chrome.storage.local.set({
        lastMarkdown: currentMarkdown,
        lastTitle: currentTitle,
        lastImageUrls: currentImageUrls,
      }).catch(() => {});
    }
    if (pollTimer) clearInterval(pollTimer);
  });

})();
