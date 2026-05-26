// ============================================================
// 飞书文档转换器 - Popup Script (v2.13)
// v2.13 batch8: pollConversion not_found处理(P0)+exportDocx命名修正(P1)+navigateToUrl URL校验(P1)+工具函数同步对齐(P2)
// 功能：Tab切换、URL粘贴导航、后台持久转换、XSS安全DOCX、ZIP下载、历史
// v2.8 修复：list_active_tasks空指针保护（resp?.tasks?.length）
// v2.9 URL安全：sanitizeUrl 协议白名单已覆盖所有导出路径
// 修复：活跃任务恢复、localStorage溢出、DOCX URL协议白名单、HTML实体保护
// v2.4 新增：DOCX h5/h6支持、CSS ol/ul样式、tab监听器内存泄漏修复、版本号同步
// v2.5 新增：DOCX URL &amp; 还原、unload→pagehide
// v2.6 新增：ZIP replaceAll全局替换、DOCX空行可见化、page超限告警
// v2.7 新增：DOCX块级间距优化、恢复历史预览同步、ZIP失败URL报告
// v2.9 batch4: poll_task action修正/轮询竞态保护(pollingActive)
// ============================================================

(function () {
  'use strict';

  let currentMarkdown = '';
  let currentTitle = 'untitled';
  let currentImageUrls = [];
  let currentTaskId = null;
  let pollTimer = null;
  let pollingActive = false;

  const $ = (id) => document.getElementById(id);
  const el = {
    urlInput: $('urlInput'), btnUrlGo: $('btnUrlGo'), btnConvert: $('btnConvert'), btnDownload: $('btnDownload'),
    btnZip: $('btnZip'), btnDocx: $('btnDocx'), btnCopy: $('btnCopy'), btnPreview: $('btnPreview'),
    docTitle: $('docTitle'), docUrl: $('docUrl'), status: $('status'), progressWrap: $('progressWrap'),
    progressFill: $('progressFill'), stats: $('stats'), preview: $('preview'),
    optTables: $('optTables'), optImages: $('optImages'), optLinks: $('optLinks'), optDebug: $('optDebug'),
    historyList: $('historyList'), tabConvert: $('tabConvert'), tabHistory: $('tabHistory'),
  };

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      if (target === 'convert') el.tabConvert.classList.add('active');
      else if (target === 'history') { el.tabHistory.classList.add('active'); renderHistory(); }
    });
  });

  function showStatus(msg, type = 'loading') { el.status.textContent = msg; el.status.className = `status show ${type}`; }
  function hideStatus() { el.status.className = 'status'; }
  function setProgress(pct, text = '') { el.progressWrap.classList.add('show'); el.progressFill.style.width = `${pct}%`; if (text) el.stats.textContent = text; }
  function hideProgress() { el.progressWrap.classList.remove('show'); el.progressFill.style.width = '0%'; el.stats.textContent = ''; }
  function enableButtons(hasResult) { el.btnDownload.disabled = !hasResult; el.btnZip.disabled = !hasResult || currentImageUrls.length === 0; el.btnDocx.disabled = !hasResult; el.btnCopy.disabled = !hasResult; }

  function escapeHtml(str) {
    return String(str).replace(/&(?!(?:amp|lt|gt|quot|#39|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function parsePastedUrl(url) {
    const hostMatch = url.match(/https?:\/\/([^\/]+)/); if (!hostMatch) return null;
    const host = hostMatch[1];
    if (!/\.feishu\.cn$/.test(host) && !/\.larksuite\.com$/.test(host)) return null;
    const patterns = [
      { regex: /\/wiki\/([A-Za-z0-9_-]+)/, type: 'wiki' }, { regex: /\/docx\/([A-Za-z0-9_-]+)/, type: 'docx' },
      { regex: /\/docs\/([A-Za-z0-9_-]+)/, type: 'docs' }, { regex: /\/mindnotes\/([A-Za-z0-9_-]+)/, type: 'mindnote' },
      { regex: /\/sheets\/([A-Za-z0-9_-]+)/, type: 'sheet' }, { regex: /\/space\/([A-Za-z0-9_-]+)/, type: 'space' },
      { regex: /\/base\/([A-Za-z0-9_-]+)/, type: 'bitable' },
    ];
    for (const p of patterns) { const match = url.match(p.regex); if (match) return { type: p.type, token: match[1], host, url }; }
    return null;
  }

  async function detectDoc() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) { el.docTitle.textContent = '⚠ 无法获取当前标签页'; el.btnConvert.disabled = true; return; }
      const resp = await chrome.tabs.sendMessage(tab.id, { action: 'get_doc_info' });
      if (resp && resp.token) {
        el.docTitle.textContent = resp.title || 'untitled'; el.docUrl.textContent = resp.url || ''; el.docUrl.style.display = 'block';
        el.btnConvert.disabled = false; if (!el.urlInput.value) el.urlInput.value = resp.url || '';
        return { tabId: tab.id, info: resp };
      } else { el.docTitle.textContent = resp?.error || '⚠ 非飞书文档页面'; el.btnConvert.disabled = true; return null; }
    } catch (err) { el.docTitle.textContent = '⚠ 当前页面不支持（需刷新后重试）'; el.btnConvert.disabled = true; return null; }
  }

  async function navigateToUrl(url) {
    const parsed = parsePastedUrl(url);
    if (!parsed) { showStatus('❌ 无效的飞书文档链接', 'error'); return false; }
    if (parsed.type === 'mindnote' || parsed.type === 'sheet' || parsed.type === 'bitable') { showStatus(`⚠ ${parsed.type} 类型暂不支持 API 解析，仅支持 wiki/docx/docs/space`, 'error'); return false; }
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab || !tab.id) return false;
      showStatus('🔄 正在打开文档...', 'loading');
      await chrome.tabs.update(tab.id, { url: parsed.url });
      await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn) => { if (settled) return; settled = true; chrome.tabs.onUpdated.removeListener(listener); fn(); };
        chrome.tabs.get(tab.id, (currentTab) => { if (currentTab?.status === 'complete' && currentTab?.url === parsed.url) settle(resolve); });
        const listener = (tabId, changeInfo) => { if (tabId === tab.id && changeInfo.status === 'complete') settle(resolve); };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => settle(() => reject(new Error('页面加载超时'))), 15000);
      });
      await new Promise(r => setTimeout(r, 1000));
      hideStatus(); await detectDoc(); return true;
    } catch (err) { showStatus(`❌ 导航失败: ${err.message}`, 'error'); return false; }
  }

  async function requestConvert() {
    el.btnConvert.disabled = true; el.btnConvert.textContent = '⏳ 准备...'; hideStatus(); hideProgress();
    const docCtx = await detectDoc();
    if (!docCtx) { el.btnConvert.textContent = '🔄 开始转换'; el.btnConvert.disabled = false; return; }
    const options = { tables: el.optTables.checked, images: el.optImages.checked, links: el.optLinks.checked, debug: el.optDebug.checked };
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'start_conversion', tabId: docCtx.tabId, options });
      currentTaskId = resp.taskId;
      if (!currentTaskId) throw new Error('后台任务创建失败（未返回任务ID），请重试');
      el.btnConvert.textContent = '⏳ 转换中...'; showStatus('⏳ 正在转换（后台运行，可关闭此窗口）...', 'loading'); setProgress(10, '已提交后台任务');
      await pollConversion();
    } catch (err) { showStatus(`❌ ${err.message}`, 'error'); el.btnConvert.textContent = '🔄 重试'; el.btnConvert.disabled = false; hideProgress(); }
  }

  async function pollConversion() {
    if (pollTimer) clearTimeout(pollTimer);
    if (pollingActive) { console.warn('[飞书转换器] 轮询已在进行中，跳过重复调用'); throw new Error('轮询已在进行中'); }
    pollingActive = true;
    const maxPolls = 120; let polls = 0; let lastProgress = 10; let failCount = 0; const baseDelay = 1000;
    return new Promise((resolve, reject) => {
      const poll = () => {
        polls++;
        if (polls > maxPolls) { pollTimer = null; pollingActive = false; showStatus('❌ 转换超时', 'error'); el.btnConvert.textContent = '🔄 重试'; el.btnConvert.disabled = false; hideProgress(); reject(new Error('转换超时')); return; }
        lastProgress = Math.min(lastProgress + 0.5, 90); setProgress(lastProgress, `轮询中... (${polls}s)`);
        chrome.runtime.sendMessage({ action: 'poll_task', taskId: currentTaskId }).then(resp => {
          if (!resp) { failCount++; const delay = Math.min(baseDelay * (1 + failCount * 0.5), 5000); pollTimer = setTimeout(poll, delay); return; }
          failCount = 0;
          if (resp.status === 'not_found') { pollTimer = null; pollingActive = false; showStatus('❌ 后台任务已过期（可能超时被清理），请重新转换', 'error'); el.btnConvert.textContent = '🔄 重试'; el.btnConvert.disabled = false; hideProgress(); reject(new Error('后台任务已过期，请重新转换')); return; }
          if (resp.status === 'done') {
            if (!resp.result) { pollingActive = false; showStatus('❌ 转换结果异常（后台未返回结果数据）', 'error'); el.btnConvert.textContent = '🔄 重试'; el.btnConvert.disabled = false; hideProgress(); reject(new Error('后台未返回结果数据，请重试')); return; }
            if (resp.result.markdown === undefined) { pollingActive = false; showStatus('❌ 转换结果异常（Markdown 内容为空）', 'error'); el.btnConvert.textContent = '🔄 重试'; el.btnConvert.disabled = false; hideProgress(); reject(new Error('Markdown 内容为空，可能是文档无内容或权限不足')); return; }
            pollTimer = null; currentMarkdown = resp.result.markdown; currentTitle = resp.result.title; currentImageUrls = resp.result.imageUrls || [];
            setProgress(100, `✅ 完成 | ${currentTitle} | ${(currentMarkdown.length / 1024).toFixed(1)} KB | ${currentImageUrls.length} 张图${resp.result.truncated ? ' (已达页数上限)' : ''}`);
            enableButtons(true); el.btnConvert.textContent = '🔄 再次转换'; el.btnConvert.disabled = false;
            if (resp.result.unresolvedRefs > 0) showStatus(`⚠ 有 ${resp.result.unresolvedRefs} 处跨页引用未能解析`, 'error');
            else showStatus(`✅ 转换完成 — ${(currentMarkdown.length / 1024).toFixed(1)} KB，${currentImageUrls.length} 张图片`, 'success');
            saveToHistory(); pollingActive = false; resolve();
          } else if (resp.status === 'error') { pollTimer = null; pollingActive = false; showStatus(`❌ ${resp.error}`, 'error'); el.btnConvert.textContent = '🔄 重试'; el.btnConvert.disabled = false; hideProgress(); reject(new Error(resp.error)); }
          else { pollTimer = setTimeout(poll, baseDelay); }
        }).catch(() => { failCount++; const delay = Math.min(baseDelay * (1 + failCount * 0.5), 5000); pollTimer = setTimeout(poll, delay); });
      };
      poll();
    });
  }

  function downloadMarkdown() {
    if (!currentMarkdown) return;
    const blob = new Blob([currentMarkdown], { type: 'text/markdown' }); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${sanitizeFilename(currentTitle)}.md`; a.click(); URL.revokeObjectURL(url);
    showStatus('✅ Markdown 已下载', 'success');
  }

  async function downloadImagesZip() {
    if (!currentMarkdown || currentImageUrls.length === 0) { showStatus('⚠ 没有可下载的图片', 'error'); return; }
    el.btnZip.disabled = true; el.btnZip.textContent = '⏳ 下载中...'; showStatus(`⏳ 正在下载 ${currentImageUrls.length} 张图片...`, 'loading');
    try {
      const zip = new JSZip(); const imgFolder = zip.folder('images'); let downloaded = 0; const failedUrls = [];
      let markdown = currentMarkdown; const maxConcurrent = 5; const urlList = [...currentImageUrls];
      for (let i = 0; i < urlList.length; i += maxConcurrent) {
        const batch = urlList.slice(i, i + maxConcurrent);
        const results = await Promise.allSettled(batch.map(async (img, idx) => {
          try {
            const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 15000);
            const resp = await fetch(img.url, { mode: 'cors', signal: ctrl.signal }); clearTimeout(timer);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`); const blob = await resp.blob();
            const contentType = resp.headers.get('content-type') || ''; let ext = 'png';
            if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = 'jpg';
            else if (contentType.includes('gif')) ext = 'gif'; else if (contentType.includes('svg')) ext = 'svg';
            else if (contentType.includes('webp')) ext = 'webp';
            const filename = `img_${String(i + idx).padStart(3, '0')}.${ext}`; imgFolder.file(filename, blob);
            markdown = markdown.split(img.url).join(`images/${filename}`); return { success: true, filename };
          } catch (err) { return { success: false, url: img.url, error: err.message }; }
        }));
        for (const r of results) { if (r.status === 'fulfilled' && r.value?.success) downloaded++; else if (r.status === 'fulfilled') failedUrls.push(r.value?.url || 'unknown'); else failedUrls.push('(网络错误)'); }
        setProgress(Math.round((i + batch.length) / urlList.length * 100), `已下载 ${downloaded}/${urlList.length}`);
      }
      zip.file(`${currentTitle}.md`, markdown);
      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const zipUrl = URL.createObjectURL(zipBlob); const a = document.createElement('a'); a.href = zipUrl;
      a.download = `${sanitizeFilename(currentTitle)}_with_images.zip`; a.click(); URL.revokeObjectURL(zipUrl);
      currentMarkdown = markdown;
      if (downloaded === 0) showStatus(`❌ ZIP 打包失败: 所有 ${urlList.length} 张图片下载失败`, 'error');
      else if (failedUrls.length > 0) showStatus(`✅ ZIP 打包完成 — ${downloaded}/${urlList.length} 张 (${failedUrls.length} 张失败)`, 'success');
      else showStatus(`✅ ZIP 打包完成 — ${downloaded}/${urlList.length} 张图片`, 'success');
    } catch (err) { showStatus(`❌ ZIP 打包失败: ${err.message}`, 'error'); }
    finally { el.btnZip.textContent = '📦 图片+ZIP'; el.btnZip.disabled = false; hideProgress(); }
  }

  function sanitizeUrl(rawUrl) {
    const trimmed = rawUrl.trim(); if (!trimmed) return '#';
    if (/^[#\/]/.test(trimmed)) return trimmed;
    if (/^data:image\/(png|jpeg|gif|webp|bmp|tiff);/i.test(trimmed)) return trimmed;
    const protocolMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):/);
    if (protocolMatch) { const protocol = protocolMatch[1].toLowerCase(); const allowed = ['http', 'https', 'ftp', 'mailto']; if (!allowed.includes(protocol)) return '#'; }
    return trimmed;
  }

  function sanitizeFilename(name) {
    if (!name) return '';
    return name.replace(/[\\/:*?"<>|]/g, '_').replace(/[\x00-\x1f\x7f]/g, '').replace(/\.\./g, '_').replace(/^\.+/, '_').trim().substring(0, 200);
  }

  function exportDocx() {
    if (!currentMarkdown) return; el.btnDocx.disabled = true; el.btnDocx.textContent = '⏳ 导出中...';
    try {
      const safeMd = escapeHtml(currentMarkdown);
      let html = safeMd
        .replace(/^###### (.+)$/gm, '<h6>$1</h6>').replace(/^##### (.+)$/gm, '<h5>$1</h5>').replace(/^#### (.+)$/gm, '<h4>$1</h4>')
        .replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => `<img src="${sanitizeUrl(url).replace(/&amp;/g, '&')}" alt="${alt}">`)
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => `<a href="${sanitizeUrl(url).replace(/&amp;/g, '&')}">${text}</a>`)
        .replace(/^---$/gm, '<hr>').replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
        .replace(/^\d+\. (.+)$/gm, '<__ol__>$1</__ol__>').replace(/^- (.+)$/gm, '<__ul__>$1</__ul__>').replace(/^(?!<[a-z_\/])(.+)$/gm, '<p>$1</p>');
      html = html.replace(/(<__ol__>[\s\S]*?<\/__ol__>)(\n<__ol__>[\s\S]*?<\/__ol__>)*/g, (m) => { const items = m.replace(/<__ol__>([\s\S]*?)<\/__ol__>/g, '<li>$1</li>'); return `<ol>${items}</ol>`; });
      html = html.replace(/(<__ul__>[\s\S]*?<\/__ul__>)(\n<__ul__>[\s\S]*?<\/__ul__>)*/g, (m) => { const items = m.replace(/<__ul__>([\s\S]*?)<\/__ul__>/g, '<li>$1</li>'); return `<ul>${items}</ul>`; });
      html = html.replace(/\n\n+/g, '<br><br>'); html = html.replace(/\n/g, '');
      html = html.replace(/<\/(p|h[1-6]|li|ol|ul|blockquote|pre|hr)><br><br><([a-z])/g, '</$1><$2');
      const fullHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + escapeHtml(currentTitle) + '</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:800px;margin:40px auto;padding:20px;line-height:1.8;color:#333}h1{font-size:24px;border-bottom:2px solid #eee;padding-bottom:8px}h2{font-size:20px;margin-top:24px}h3{font-size:17px;margin-top:20px}h4{font-size:15px;margin-top:16px}h5{font-size:13px;margin-top:14px;color:#555}h6{font-size:12px;margin-top:12px;color:#777;font-style:italic}p{margin:8px 0}ol,ul{margin:8px 0 8px 24px;padding:0}li{margin:4px 0;line-height:1.6}ol li{list-style-type:decimal}ul li{list-style-type:disc}code{background:#f5f5f5;padding:2px 6px;border-radius:3px;font-family:"SF Mono",Consolas,monospace;font-size:13px}pre{background:#f5f5f5;padding:12px 16px;border-radius:6px;overflow-x:auto}pre code{background:none;padding:0}blockquote{border-left:3px solid #4A6CF7;padding:4px 12px;margin:8px 0;color:#666;background:#f8f9ff}img{max-width:100%;height:auto;border-radius:4px}hr{border:none;border-top:1px solid #eee;margin:16px 0}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #ddd;padding:8px 12px;text-align:left}th{background:#f5f5f5}</style></head><body>' + html + '</body></html>';
      const blob = new Blob(['\ufeff' + fullHtml], { type: 'application/msword' }); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `${sanitizeFilename(currentTitle)}.doc`; a.click(); URL.revokeObjectURL(url);
    } catch (err) { showStatus(`❌ DOCX 导出失败: ${err.message}`, 'error'); }
    finally { el.btnDocx.textContent = '📝 导出 .doc'; el.btnDocx.disabled = false; }
  }

  async function copyToClipboard() {
    if (!currentMarkdown) return;
    try { await navigator.clipboard.writeText(currentMarkdown); showStatus('✅ 已复制到剪贴板', 'success'); setTimeout(hideStatus, 2000); }
    catch (err) { showStatus('❌ 复制失败，请尝试重新选择文本', 'error'); }
  }

  function togglePreview() {
    if (!currentMarkdown) return;
    if (el.preview.classList.contains('show')) { el.preview.classList.remove('show'); el.btnPreview.textContent = '👁 预览'; }
    else { el.preview.textContent = currentMarkdown.slice(0, 8000) + (currentMarkdown.length > 8000 ? '\n\n... (内容过长，仅显示前 8000 字符)' : ''); el.preview.classList.add('show'); el.btnPreview.textContent = '🙈 隐藏'; }
  }

  const HISTORY_META_KEY = 'feishu_conv_history_meta';
  const HISTORY_CONTENT_PREFIX = 'history_content_';
  function loadHistoryMeta() { try { return JSON.parse(localStorage.getItem(HISTORY_META_KEY) || '[]'); } catch { return []; } }
  function saveHistoryMeta(meta) { localStorage.setItem(HISTORY_META_KEY, JSON.stringify(meta)); }

  async function saveToHistory() {
    if (!currentMarkdown || !currentTitle) return;
    const meta = loadHistoryMeta(); const existing = meta.findIndex(h => h.title === currentTitle); if (existing >= 0) meta.splice(existing, 1);
    const entry = { title: currentTitle, imageCount: currentImageUrls.length, date: new Date().toLocaleString('zh-CN'), size: currentMarkdown.length, contentKey: HISTORY_CONTENT_PREFIX + encodeURIComponent(currentTitle) };
    meta.unshift(entry); const trimmed = meta.slice(0, 20); saveHistoryMeta(trimmed);
    const keysToKeep = new Set(trimmed.map(h => h.contentKey));
    const allStorage = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(allStorage).filter(k => k.startsWith(HISTORY_CONTENT_PREFIX) && !keysToKeep.has(k));
    if (keysToRemove.length > 0) await chrome.storage.local.remove(keysToRemove);
    await chrome.storage.local.set({ [entry.contentKey]: { markdown: currentMarkdown, imageUrls: currentImageUrls } });
  }

  function renderHistory() {
    const meta = loadHistoryMeta();
    if (meta.length === 0) { el.historyList.innerHTML = '<div style="text-align:center;color:#888;padding:20px;font-size:13px;">暂无历史记录</div>'; return; }
    el.historyList.innerHTML = meta.map((h, i) => '<div class="history-item" data-idx="' + i + '"><span class="h-title" title="' + escapeHtml(h.title) + '">' + escapeHtml(h.title) + '</span><span class="h-meta">' + (h.size / 1024).toFixed(1) + ' KB · ' + h.date + '</span><span class="h-del" data-idx="' + i + '">×</span></div>').join('');
    el.historyList.querySelectorAll('.h-title').forEach(item => { item.addEventListener('click', (e) => { const idx = parseInt(e.target.closest('.history-item').dataset.idx); restoreFromHistory(idx); }); });
    el.historyList.querySelectorAll('.h-del').forEach(del => { del.addEventListener('click', (e) => { e.stopPropagation(); const idx = parseInt(del.dataset.idx); deleteHistory(idx); }); });
  }

  async function restoreFromHistory(idx) {
    const meta = loadHistoryMeta(); if (idx < 0 || idx >= meta.length) return; const h = meta[idx];
    try {
      const data = await chrome.storage.local.get(h.contentKey); const content = data[h.contentKey];
      if (!content) { showStatus('⚠ 历史内容已过期', 'error'); return; }
      currentMarkdown = content.markdown; currentTitle = h.title; currentImageUrls = content.imageUrls || []; enableButtons(true);
      if (el.preview.classList.contains('show')) el.preview.textContent = currentMarkdown.slice(0, 8000) + (currentMarkdown.length > 8000 ? '\n\n... (内容过长，仅显示前 8000 字符)' : '');
      showStatus(`✅ 已恢复: ${h.title} (${(h.size / 1024).toFixed(1)} KB)`, 'success');
    } catch (e) { showStatus('⚠ 恢复失败: ' + e.message, 'error'); return; }
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.tab[data-tab="convert"]').classList.add('active');
    el.tabConvert.classList.add('active'); el.tabHistory.classList.remove('active');
  }

  async function deleteHistory(idx) {
    const meta = loadHistoryMeta(); if (idx < 0 || idx >= meta.length) return;
    const removed = meta.splice(idx, 1); saveHistoryMeta(meta);
    if (removed.length > 0) await chrome.storage.local.remove(removed[0].contentKey);
    renderHistory();
  }

  el.btnConvert.addEventListener('click', requestConvert);
  el.btnDownload.addEventListener('click', downloadMarkdown);
  el.btnZip.addEventListener('click', downloadImagesZip);
  el.btnDocx.addEventListener('click', exportDocx);
  el.btnCopy.addEventListener('click', copyToClipboard);
  el.btnPreview.addEventListener('click', togglePreview);
  el.btnUrlGo.addEventListener('click', async () => { const url = el.urlInput.value.trim(); if (!url) { showStatus('⚠ 请粘贴飞书文档链接', 'error'); return; } el.btnUrlGo.disabled = true; el.btnUrlGo.textContent = '⏳'; await navigateToUrl(url); el.btnUrlGo.textContent = '打开'; el.btnUrlGo.disabled = false; });
  el.urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.btnUrlGo.click(); });

  (async function init() {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'list_active_tasks' });
      if (resp?.tasks?.length > 0) { const activeTask = resp.tasks[0]; currentTaskId = activeTask.id; el.btnConvert.textContent = '⏳ 恢复转换...'; el.btnConvert.disabled = true; showStatus('⏳ 检测到后台转换任务，正在恢复...', 'loading'); setProgress(10, '恢复后台任务'); try { await pollConversion(); } catch (e) {} }
    } catch (e) {}
    try {
      const last = await chrome.storage.local.get(['lastMarkdown', 'lastTitle', 'lastImageUrls']);
      if (last.lastMarkdown) { currentMarkdown = last.lastMarkdown; currentTitle = last.lastTitle || 'untitled'; currentImageUrls = last.lastImageUrls || []; enableButtons(true); if (!currentTaskId) { showStatus(`📦 已恢复上次转换结果: ${currentTitle}`, 'success'); setTimeout(hideStatus, 3000); } }
    } catch (e) {}
    await detectDoc();
  })();

  window.addEventListener('pagehide', () => {
    if (currentMarkdown) { chrome.storage.local.set({ lastMarkdown: currentMarkdown, lastTitle: currentTitle, lastImageUrls: currentImageUrls }).catch((e) => { console.warn('[飞书转换器] pagehide 保存失败:', e?.message || e); }); }
    if (pollTimer) clearTimeout(pollTimer);
  });
})();
