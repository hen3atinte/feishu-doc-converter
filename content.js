// content.js - 飞书文档内容提取与转换引擎
// 注入到飞书文档页面，利用页面已有登录态调用API

(function () {
  'use strict';

  // ========== 工具函数 ==========

  // 从 text 对象提取纯文本
  function getText(blockData) {
    const textObj = blockData?.text?.initialAttributedTexts?.text;
    if (!textObj) return '';
    const keys = Object.keys(textObj).map(Number).sort((a, b) => a - b);
    return keys.map(k => textObj[String(k)]).join('');
  }

  // 提取链接（如果有）
  function getLinks(blockData) {
    const links = [];
    const elems = blockData?.text?.initialAttributedTexts?.elements || [];
    for (const e of elems) {
      if (e?.link) links.push(e.link);
    }
    return links;
  }

  // ========== Block 解析器 ==========

  const BlockParser = {
    // 普通文本
    text(block, ctx) {
      const t = getText(block.data);
      return t ? `${t}\n` : '';
    },

    // 三级标题
    heading3(block, ctx) {
      const t = getText(block.data);
      return t ? `\n### ${t}\n` : '';
    },

    // 四级标题
    heading4(block, ctx) {
      const t = getText(block.data);
      return t ? `\n#### ${t}\n` : '';
    },

    // 无序列表
    bullet(block, ctx) {
      const t = getText(block.data);
      const indent = '  '.repeat(Math.min(ctx.depth || 0, 5));
      return t ? `${indent}- ${t}\n` : '';
    },

    // 有序列表
    ordered(block, ctx) {
      const t = getText(block.data);
      ctx.orderedCounter = (ctx.orderedCounter || 0) + 1;
      const indent = '   '.repeat(Math.min(ctx.depth || 0, 5));
      return t ? `${indent}${ctx.orderedCounter}. ${t}\n` : '';
    },

    // 引用块
    callout(block, ctx) {
      const t = getText(block.data);
      return t ? `\n> ${t}\n` : '';
    },

    // 分隔线
    divider(block, ctx) {
      return '\n---\n';
    },

    // 代码块
    code(block, ctx) {
      const t = getText(block.data);
      return t ? `\n\`\`\`\n${t}\n\`\`\`\n` : '';
    },

    // 表格
    table(block, ctx) {
      if (!ctx.options.tables) return '\n[表格]\n';
      // 飞书表格结构：children 里是 table_row 类型的 block
      const rows = [];
      const children = block.data?.children || [];
      for (const childId of children) {
        const child = ctx.blockMap[childId];
        if (child?.data?.type === 'table_row') {
          const cells = (child.data?.children || [])
            .map(cid => {
              const c = ctx.blockMap[cid];
              return c ? getText(c.data) : '';
            })
            .map(c => c.trim());
          rows.push(cells);
        }
      }
      if (rows.length === 0) return '\n[空表格]\n';
      // 生成 Markdown 表格
      const header = rows[0];
      const sep = header.map(() => '---');
      const body = rows.slice(1).map(r => r.join(' | ')).join('\n');
      return `\n| ${header.join(' | ')} |\n| ${sep.join(' | ')} |\n${body ? body.split('\n').map(r => `| ${r} |`).join('\n') : ''}\n`;
    },

    // 图片
    image(block, ctx) {
      const src = block.data?.image?.source_url ||
                  block.data?.file?.source_url || '';
      const alt = getText(block.data) || 'image';
      if (!src) return '\n[图片]\n';
      if (ctx.options.images) {
        // 尝试下载图片（通过 background 处理）
        return `\n![${alt}](${src})\n`;
      }
      return `\n![${alt}](${src})\n`;
    },

    // 链接卡片（飞书特有）
    link_card(block, ctx) {
      const url = block.data?.link_card?.url || '';
      return url ? `\n🔗 ${url}\n` : '';
    },

    // 待办
    todo(block, ctx) {
      const t = getText(block.data);
      const checked = block.data?.todo?.checked || false;
      const box = checked ? '[x]' : '[ ]';
      return t ? `- ${box} ${t}\n` : '';
    },

    // 默认处理
    _default(block, ctx) {
      const t = getText(block.data);
      return t ? `${t}\n` : '';
    }
  };

  // ========== 递归处理 Block ==========

  function processBlock(blockId, blockMap, options, depth = 0, orderedCounter = 0) {
    const block = blockMap[blockId];
    if (!block) return '';

    const type = block.data?.type || 'text';
    const ctx = { blockMap, options, depth, orderedCounter, counter: {} };

    let result = '';

    // 调用对应的解析器
    const parser = BlockParser[type] || BlockParser._default;
    result += parser(block, ctx);

    // 递归处理子节点（table 块已由解析器自行处理，跳过以防止重复解析）
    if (type !== 'table') {
      const children = block.data?.children || [];
      for (const childId of children) {
        result += processBlock(childId, blockMap, options, depth + 1, orderedCounter);
      }
    }

    return result;
  }

  // ========== API 调用 ==========

  // 从页面上下文 fetch 飞书 API（利用已有 cookie）
  async function fetchDocPage(token, cursor = '', pageNum = 1) {
    const url = new URL('https://ta6hb0ysuge.feishu.cn/space/api/docx/pages/client_vars');
    url.searchParams.set('id', token);
    url.searchParams.set('mode', '7');
    url.searchParams.set('limit', '239');
    if (cursor) url.searchParams.set('cursor', cursor);

    const resp = await fetch(url.toString(), {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      }
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  // ========== 主转换函数 ==========

  async function convertDoc(options = {}) {
    const opts = {
      tables: true,
      images: true,
      links: true,
      debug: false,
      ...options,
    };

    // 提取 token
    const token = extractToken(window.location.href);
    if (!token) throw new Error('无法从URL提取文档ID');

    if (opts.debug) console.log('[FeishuConverter] Starting conversion, token:', token);

    let allLines = [];
    let cursor = '';
    let page = 1;
    const seen = new Set();

    // 获取第一页以提取标题
    let firstTitle = '';

    while (true) {
      if (opts.debug) console.log(`[FeishuConverter] Fetching page ${page}...`);
      const data = await fetchDocPage(token, cursor, page);
      if (!data || data.code !== 0) {
        if (opts.debug) console.warn('[FeishuConverter] API returned error:', data);
        break;
      }

      const d = data.data;
      const blockMap = d.block_map || {};
      const blockSequence = d.block_sequence || [];

      // 提取标题（仅第一页）
      if (page === 1) {
        const metaMap = d.meta_map || {};
        for (const mid of Object.keys(metaMap)) {
          const m = metaMap[mid];
          if (m?.title) {
            firstTitle = m.title;
            break;
          }
        }
        if (firstTitle) allLines.push(`# ${firstTitle}\n`);
      }

      // 处理 blocks
      for (const blockId of blockSequence) {
        const line = processBlock(blockId, blockMap, opts);
        // 去重（按内容）
        if (line && !seen.has(line)) {
          seen.add(line);
          allLines.push(line);
        }
      }

      if (opts.debug) console.log(`[FeishuConverter] Page ${page}: ${Object.keys(blockMap).length} blocks`);

      // 检查是否有更多页
      const hasMore = d.has_more || false;
      const cursors = d.next_cursors || [];
      if (!hasMore || cursors.length === 0) break;

      cursor = cursors[0];
      page++;
    }

    // 后处理：清理多余空行
    let markdown = allLines.join('');
    markdown = markdown.replace(/\n{3,}/g, '\n\n');
    markdown = markdown.replace(/---\s*\n\s*---/g, '---');
    markdown = markdown.trim();

    if (opts.debug) console.log('[FeishuConverter] Done. Total chars:', markdown.length);

    return {
      markdown,
      title: firstTitle || document.title || 'untitled',
      pages: page,
    };
  }

  // ========== 辅助：从 URL 提取 token ==========

  function extractToken(url) {
    const patterns = [
      /feishu\.cn\/wiki\/([a-zA-Z0-9]+)/,
      /feishu\.cn\/docx\/([a-zA-Z0-9]+)/,
      /larksuite\.com\/wiki\/([a-zA-Z0-9]+)/,
      /larksuite\.com\/docx\/([a-zA-Z0-9]+)/,
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  }

  // ========== 监听来自 popup 的消息 ==========

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'convert_doc') {
      convertDoc(message.options || {})
        .then(result => {
          sendResponse({ markdown: result.markdown, title: result.title });
        })
        .catch(err => {
          sendResponse({ error: err.message });
        });
      return true; // 异步响应
    }

    if (message.action === 'get_doc_info') {
      const token = extractToken(window.location.href);
      sendResponse({
        title: document.title || '',
        token: token || '',
        url: window.location.href,
      });
      return true;
    }
  });

  // 通知 popup 已就绪
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.sendMessage({ action: 'content_ready' }).catch(() => {});
  }

  if (window.location.href.includes('feishu.cn') || window.location.href.includes('larksuite.com')) {
    console.log('[FeishuConverter] Content script loaded on:', window.location.href);
  }

})();
