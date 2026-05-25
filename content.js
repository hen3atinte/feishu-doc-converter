// ============================================================
// 飞书文档转换器 - Content Script (v2.8)
// 功能：富文本渲染、多路径API、跨页引用解析、全块类型支持
// v2.4-2.7 修复历史见 CHANGELOG
// v2.8 新增：P0×7修复(页截断误判/颜色剥离/XSS/语言路径/assignees类型)、API超时+非JSON保护、无限递归path检测、LANG_ALIAS 50+语言、颜色映射补全、inlineCode+粗体组合
// ============================================================

(function () {
  'use strict';

  // 模块级选项（供 renderElement 等底层函数读取）
  let _convertOpts = {};

  // ---- 代码语言别名（模块级常量，避免每次调用 code() 重建对象） ----
  const LANG_ALIAS = {
    'typescript': 'ts', 'javascript': 'js', 'python': 'python',
    'python3': 'python', 'py': 'python', 'golang': 'go',
    'shell': 'bash', 'sh': 'bash', 'zsh': 'bash',
    'c++': 'cpp', 'c#': 'csharp', 'objective-c': 'objc',
    'xml': 'xml', 'yml': 'yaml', 'markdown': 'md',
    'java': 'java', 'kotlin': 'kt', 'swift': 'swift',
    'rust': 'rust', 'php': 'php', 'html': 'html',
    'css': 'css', 'sql': 'sql', 'ruby': 'ruby',
    'dart': 'dart', 'lua': 'lua', 'scala': 'scala',
    'r': 'r', 'perl': 'perl', 'groovy': 'groovy',
    'powershell': 'powershell', 'dockerfile': 'dockerfile',
    'makefile': 'makefile', 'graphql': 'graphql',
    'json': 'json', 'diff': 'diff', 'nginx': 'nginx',
    'cmake': 'cmake', 'less': 'less', 'scss': 'scss',
    'toml': 'toml', 'ini': 'ini', 'tex': 'latex',
    'matlab': 'matlab', 'vb': 'vbnet', 'batch': 'batch',
    'elixir': 'elixir', 'haskell': 'haskell', 'clojure': 'clojure',
  };

  // ---- 颜色 ID 映射表（飞书颜色 → CSS 颜色名，用于 Markdown 背景高亮标注） ----
  const FEISHU_COLORS = {
    // 文字颜色
    'red': '🔴', 'orange': '🟠', 'yellow': '🟡',
    'green': '🟢', 'blue': '🔵', 'purple': '🟣',
    'grey': '⬜', 'gray': '⬜',
    'cyan': '🩵', 'teal': '🩵', 'brown': '🟤', 'pink': '🩷',
    // 背景高亮（飞书返回形如 "red_bg" / "background_red"）
    'red_bg': '[红色高亮]', 'orange_bg': '[橙色高亮]',
    'yellow_bg': '[黄色高亮]', 'green_bg': '[绿色高亮]',
    'blue_bg': '[蓝色高亮]', 'purple_bg': '[紫色高亮]',
    'grey_bg': '[灰色高亮]', 'gray_bg': '[灰色高亮]',
    'cyan_bg': '[青色高亮]', 'teal_bg': '[青色高亮]',
    'brown_bg': '[棕色高亮]', 'pink_bg': '[粉色高亮]',
  };

  // ---- 富文本渲染引擎 ----

  /**
   * 解析飞书 inline elements[] → 格式化文本
   * 支持：粗体/斜体/删除线/下划线/行内代码/链接/@文档/@用户/日期/公式/emoji
   */
  function renderRichText(blockData) {
    const iat = blockData?.initialAttributedTexts;
    if (!iat) return '';

    let result = '';

    // 遍历所有 attributed text 段
    for (const seg of iat) {
      const elements = seg.elements || [];
      if (elements.length === 0) {
        // 纯文本段（无格式）
        result += seg.text || '';
        continue;
      }

      for (const el of elements) {
        result += renderElement(el, seg);
      }
    }

    return result;
  }

  function renderElement(el, seg) {
    const type = el._type || el.type || 'textRun';

    switch (type) {
      // textRun
      case 'textRun': {
        let text = el.textRun?.text || el.text || '';
        const style = el.textRun?.textStyle || el.textStyle || {};

        // 链接优先（可能是带链接的文本）
        if (style.link?.url && _convertOpts.links !== false) {
          text = `[${text}](${style.link.url})`;
        }

        // 行内代码（Markdown 不支持反引号内嵌粗体/斜体，使用 HTML 保留格式）
        if (style.inlineCode) {
          if (style.bold && style.italic) {
            text = `<code><em><strong>${text}</strong></em></code>`;
          } else if (style.bold) {
            text = `<code><strong>${text}</strong></code>`;
          } else if (style.italic) {
            text = `<code><em>${text}</em></code>`;
          } else {
            text = `\`${text}\``;
          }
        }
        // 粗体+斜体组合（Markdown: ***text***）
        else if (style.bold && style.italic) {
          text = `***${text}***`;
        }
        // 粗体
        else if (style.bold) {
          text = `**${text}**`;
        }
        // 斜体
        else if (style.italic) {
          text = `*${text}*`;
        }

        // 删除线（可与粗体/斜体叠加）
        if (style.strikethrough) {
          text = `~~${text}~~`;
        }
        // 下划线（HTML 标签，Markdown 不支持原生下划线）
        if (style.underline) {
          text = `<u>${text}</u>`;
        }

        // 文字颜色（非默认颜色时添加 emoji 标注）
        // 飞书字段：style.foreColor / style.textColor / style.color（不同版本 API 字段名不一致）
        // ⚠️ 不剥离 background_ 前缀：若飞书错将背景色值写入文字颜色字段，不应误标为文字颜色
        const rawFg = (style.foreColor || style.textColor || style.color || '').toLowerCase();
        const fgColor = rawFg.startsWith('background_') ? '' : rawFg.replace(/ /g, '_');
        if (fgColor && fgColor !== 'default' && fgColor !== 'black' && FEISHU_COLORS[fgColor]) {
          text = `${FEISHU_COLORS[fgColor]} ${text}`;
        }

        // 背景高亮
        // 飞书字段：style.backColor / style.backgroundColor / style.bgColor
        const bgColor = (style.backColor || style.backgroundColor || style.bgColor || '').toLowerCase().replace(/ /g, '_');
        const bgKey = bgColor ? bgColor + '_bg' : '';
        if (bgKey && FEISHU_COLORS[bgKey]) {
          text = `==${text}==`; // Markdown highlight（部分渲染器支持）
        }

        return text;
      }

      // @文档
      case 'mentionDoc': {
        const title = el.mentionDoc?.title || '文档';
        const url = el.mentionDoc?.url || '';
        return url ? `[📄 ${title}](${url})` : `📄 ${title}（无可用链接）`;
      }

      // @用户
      case 'mentionUser': {
        const name = el.mentionUser?.name || el.name || '用户';
        return `@${name}`;
      }

      // 日期
      case 'mentionDate':
      case 'date': {
        const date = el.mentionDate?.date || el.date || '';
        return date ? `📅 ${date}` : '';
      }

      // 行内公式
      case 'inlineEquation':
      case 'equation': {
        const eq = el.inlineEquation?.equation || el.equation || '';
        return eq ? `$${eq}$` : '';
      }

      // Emoji
      case 'emoji': {
        const emojiId = el.emoji?.emojiId || el.emojiId || '';
        // 飞书自定义 emoji 用 :name: 格式
        if (emojiId) {
          return `:${emojiId}:`;
        }
        return el.emoji?.text || el.text || '';
      }

      // 未知类型 → 取纯文本兜底
      default:
        return el.text || '';
    }
  }

  /**
   * 兼容旧接口：纯文本提取（用于表格单元格等场景）
   */
  function getPlainText(blockData) {
    const iat = blockData?.initialAttributedTexts;
    if (!iat) return '';
    return iat.map(s => {
      if (!s.elements || s.elements.length === 0) return s.text || '';
      return s.elements.map(el => {
        if (el.textRun) return el.textRun.text || '';
        if (el.mentionDoc) return el.mentionDoc.title || '';
        if (el.mentionUser) return '@' + (el.mentionUser.name || '');
        return el.text || '';
      }).join('');
    }).join('');
  }

  // ---- 文档 URL 解析 ----

  /**
   * 从页面 URL 解析文档信息
   * 支持：wiki（知识空间）、docx（新版文档）、docs（旧版文档）、
   *       mindnotes（思维导图）、sheets（表格）、space（空间）
   */
  function parseDocUrl() {
    const url = window.location.href;
    const host = window.location.host;

    // 确认是飞书域名
    const isFeishu = /\.feishu\.cn$/.test(host) || /\.larksuite\.com$/.test(host);
    if (!isFeishu) {
      return { type: 'unknown', token: null, host: null, error: '非飞书页面' };
    }

    const patterns = [
      // 知识空间文档 /wiki/TOKEN
      { regex: /\/wiki\/([A-Za-z0-9_-]+)/, type: 'wiki' },
      // 新版文档 /docx/TOKEN
      { regex: /\/docx\/([A-Za-z0-9_-]+)/, type: 'docx' },
      // 旧版文档 /docs/TOKEN
      { regex: /\/docs\/([A-Za-z0-9_-]+)/, type: 'docs' },
      // 思维导图 /mindnotes/TOKEN
      { regex: /\/mindnotes\/([A-Za-z0-9_-]+)/, type: 'mindnote' },
      // 表格 /sheets/TOKEN
      { regex: /\/sheets\/([A-Za-z0-9_-]+)/, type: 'sheet' },
      // 空间页面 /space/TOKEN
      { regex: /\/space\/([A-Za-z0-9_-]+)/, type: 'space' },
      // Bitable /base/TOKEN
      { regex: /\/base\/([A-Za-z0-9_-]+)/, type: 'bitable' },
    ];

    for (const p of patterns) {
      const match = url.match(p.regex);
      if (match) {
        return { type: p.type, token: match[1], host, error: null };
      }
    }

    return { type: 'unknown', token: null, host, error: '无法识别文档类型' };
  }

  /**
   * 根据文档类型确定 API 端点
   */
  function getApiEndpoint(docInfo) {
    const base = `https://${docInfo.host}`;

    // wiki 和 space 类型用 /space/api/
    if (docInfo.type === 'wiki' || docInfo.type === 'space') {
      return {
        url: `${base}/space/api/docx/pages/client_vars`,
        needsTypeParam: false,
      };
    }

    // docx 类型 — 使用已验证的 space API（/docx-api/ 端点未验证）
    if (docInfo.type === 'docx') {
      return {
        url: `${base}/space/api/docx/pages/client_vars`,
        needsTypeParam: false,
      };
    }

    // 其他类型可能不支持此 API，返回 null 由调用方处理
    if (docInfo.type === 'mindnote' || docInfo.type === 'sheet' || docInfo.type === 'bitable') {
      return { url: null, error: `${docInfo.type} 类型暂不支持 API 解析` };
    }

    // 兜底：尝试 space API
    return {
      url: `${base}/space/api/docx/pages/client_vars`,
      needsTypeParam: false,
    };
  }

  // ---- 块解析器 ----

  const BlockParser = {

    // --- 标题 ---
    heading1(block) {
      const t = renderRichText(block.data);
      return t ? `\n# ${t}\n` : '';
    },
    heading2(block) {
      const t = renderRichText(block.data);
      return t ? `\n## ${t}\n` : '';
    },
    heading3(block) {
      const t = renderRichText(block.data);
      return t ? `\n### ${t}\n` : '';
    },
    heading4(block) {
      const t = renderRichText(block.data);
      return t ? `\n#### ${t}\n` : '';
    },
    heading5(block) {
      const t = renderRichText(block.data);
      return t ? `\n##### ${t}\n` : '';
    },
    heading6(block) {
      const t = renderRichText(block.data);
      return t ? `\n###### ${t}\n` : '';
    },

    // --- 正文 ---
    text(block) {
      const t = renderRichText(block.data);
      return t ? `${t}\n` : '';
    },

    // --- 列表 ---
    bullet(block, ctx) {
      const t = renderRichText(block.data);
      const indent = '  '.repeat(Math.min(ctx.depth, 4));
      return t ? `${indent}- ${t}\n` : '';
    },
    ordered(block, ctx) {
      const t = renderRichText(block.data);
      if (!t) return '';
      // 支持飞书 ordered 块的自定义 start 属性（默认 1）
      const start = block.data?.ordered?.start || 1;
      if (!(ctx.depth in ctx.counter)) ctx.counter[ctx.depth] = (start > 0 ? start : 1) - 1;
      ctx.counter[ctx.depth]++;
      const indent = '  '.repeat(Math.min(ctx.depth, 4));
      return `${indent}${ctx.counter[ctx.depth]}. ${t}\n`;
    },

    // --- 代码块 ---
    code(block) {
      const code = getPlainText(block.data) || '';
      // 语言别名标准化（使用模块级常量 LANG_ALIAS）
      const langRaw = (block.data?.code?.style?.language || block.data?.code?.language || block.data?.style?.language || '').toLowerCase();
      const lang = LANG_ALIAS[langRaw] || langRaw;
      if (!code.trim()) return '';
      return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    },

    // --- 引用 ---
    quote(block) {
      const t = renderRichText(block.data);
      if (!t) return '';
      // 保留多行：每行均加 '> ' 前缀，空行用 '>' 占位保持引用块连续性
      const lines = t.split('\n').map(l => l ? `> ${l}` : '>').join('\n');
      return `\n${lines}\n`;
    },

    // --- 高亮块/Callout ---
    callout(block) {
      const t = renderRichText(block.data);
      const color = block.data?.callout?.color || '';
      const emoji = block.data?.callout?.emoji || '';
      // 避免 emoji/label 为空时多余空格
      const parts = [];
      if (emoji) parts.push(emoji);
      if (color) parts.push(`[${color.toUpperCase()}]`);
      const header = parts.length > 0 ? `**${parts.join(' ')}**` : '**Note**';
      return t ? `\n> ${header}\n> ${t}\n` : '';
    },

    // --- 分割线 ---
    divider() {
      return '\n---\n';
    },

    // --- 表格 ---
    table(block, ctx) {
      if (ctx.options?.tables === false) {
        // 用户关闭了表格渲染 → 输出简短摘要
        return '\n[表格已省略]\n';
      }
      const bm = ctx.blockMap;
      const children = block.data?.children || [];
      if (children.length === 0) return '';

      // 读取表头行数（header_row 可为布尔或数字，默认 1）
      const headerRowProp = block.data?.table?.header_row ?? block.data?.header_row ?? true;
      let headerRows = 0;
      if (headerRowProp === true) headerRows = 1;
      else if (typeof headerRowProp === 'number') headerRows = headerRowProp;
      // false/0 表示无表头

      const rows = [];

      for (const rowId of children) {
        const rowBlock = bm[rowId];
        if (!rowBlock || rowBlock.data?.type !== 'table_row') continue;

        const rowChildren = rowBlock.data.children || [];
        const cells = [];

        for (const cellId of rowChildren) {
            const cellBlock = bm[cellId];
            if (!cellBlock) { cells.push(''); continue; }

            // 单元格内容解析策略：
            // 1. 优先用 renderRichText 处理单元格自身的 attributedTexts（行内富文本）
            // 2. 若单元格有子 block（如嵌入代码块、图片），单独递归，不与 renderRichText 叠加
            const cellChildren = cellBlock.data?.children || [];
            let inner = '';
            if (cellChildren.length > 0) {
              // 有子块 → 只递归子块，不再 renderRichText（避免双重解析）
              const parts = [];
              for (const ccId of cellChildren) {
                const cc = bm[ccId];
                if (cc && cc.data?.type !== 'table') {
                  const parsed = BlockParser[cc.data.type]?.(cc, ctx) || '';
                  parts.push(parsed.trim());
                }
              }
              inner = parts.filter(Boolean).join(' ');
            } else {
              // 无子块 → 直接解析单元格自身的富文本
              inner = renderRichText(cellBlock.data);
            }

            // 转义 Markdown 表格中可能破坏结构的特殊字符
            cells.push(inner
              .replace(/\\/g, '\\\\')
              .replace(/\|/g, '\\|')
              .replace(/\*/g, '\\*')
              .replace(/_/g, '\\_')
              .replace(/\[/g, '\\[')
              .replace(/\]/g, '\\]')
              .replace(/~/g, '\\~')
              .replace(/`/g, '\\`')
              .replace(/\n/g, ' '));
          }

        rows.push(cells);
      }

      if (rows.length === 0) return '';

      let md = '\n';
      const colCount = Math.max(...rows.map(r => r.length), 1);

      // 补齐每行列数
      for (const row of rows) {
        while (row.length < colCount) row.push('');
      }

      // 输出所有行，表头行后插入分隔符
      for (let i = 0; i < rows.length; i++) {
        md += '| ' + rows[i].join(' | ') + ' |\n';
        if (i === headerRows - 1 && headerRows > 0 && headerRows < rows.length) {
          md += '| ' + Array(colCount).fill('---').join(' | ') + ' |\n';
        }
      }

      return md + '\n';
    },

    // --- 图片 ---
    image(block, ctx) {
      const src = block.data?.image?.source_url ||
                  block.data?.file?.source_url || '';
      const alt = renderRichText(block.data) || '图片';
      if (!src) return `\n[图片: ${alt}]\n`;
      if (ctx.options?.images === false) {
        return `\n[图片: ${alt}]\n`;
      }
      if (ctx.imageUrls) {
        ctx.imageUrls.push({ url: src, alt });
      }
      return `\n![${alt}](${src})\n`;
    },

    // --- 待办 ---
    todo(block) {
      const t = renderRichText(block.data);
      const done = block.data?.todo?.done || false;
      const assignee = block.data?.todo?.assignee?.name || '';
      const extra = assignee ? ` *(负责人: @${assignee})*` : '';
      // 即使内容为空也保留 checkbox 状态（飞书支持空白待办项）
      return `- [${done ? 'x' : ' '}] ${t || '待办事项'}${extra}\n`;
    },

    // --- 链接卡片 ---
    link_card(block) {
      const url = block.data?.link_card?.url || block.data?.link?.url || '';
      const title = block.data?.link_card?.title || renderRichText(block.data) || url;
      const desc = block.data?.link_card?.description || '';
      const thumb = block.data?.link_card?.thumbnail || '';
      // 无 url 时输出纯文本信息，不丢失标题
      if (!url) return title ? `\n> 🔗 ${title}\n` : '';
      let md = `\n> **🔗 [${title}](${url})**\n`;
      if (desc) md += `> ${desc}\n`;
      if (thumb) md += `> ![thumb](${thumb})\n`;
      return md + '\n';
    },

    // --- 文件/附件 ---
    file(block) {
      const name = block.data?.file?.name || renderRichText(block.data) || '附件';
      const url = block.data?.file?.url || block.data?.file?.source_url || '';
      return url ? `\n📎 [${name}](${url})\n` : `\n📎 ${name}\n`;
    },

    // --- 多维表格/Bitable ---
    bitable(block) {
      const title = renderRichText(block.data) || '多维表格';
      const url = block.data?.bitable?.url || '';
      return url ? `\n> 📊 **多维表格**: [${title}](${url})\n` : `\n> 📊 **多维表格**: ${title}\n`;
    },

    // --- 图片组/Gallery ---
    gallery(block, ctx) {
      const children = block.data?.children || [];
      if (children.length === 0) return '';
      let images = '';
      for (const cid of children) {
        const cb = ctx.blockMap[cid];
        if (cb && cb.data?.type === 'image') {
          const src = cb.data?.image?.source_url || cb.data?.file?.source_url || '';
          if (src) {
            if (ctx.imageUrls) ctx.imageUrls.push({ url: src, alt: 'gallery' });
            images += `![gallery](${src})\n\n`;
          }
        }
      }
      // 无有效图片时不输出空容器
      if (!images.trim()) return '';
      return '\n<div class="gallery">\n\n' + images + '</div>\n\n';
    },

    // --- 任务 ---
    task(block) {
      const t = renderRichText(block.data) || '任务';
      const rawAssignees = block.data?.task?.assignees;
      const assignees = Array.isArray(rawAssignees) ? rawAssignees.map(a => a && a.name || '').filter(Boolean).join(', ') : '';
      const dueDate = block.data?.task?.due_date || '';
      const status = block.data?.task?.status || '';
      let extra = [];
      if (assignees) extra.push(`负责人: ${assignees}`);
      if (dueDate) extra.push(`截止: ${dueDate}`);
      if (status) extra.push(`状态: ${status}`);
      const meta = extra.length > 0 ? ` (${extra.join(' | ')})` : '';
      return `\n> ✅ **任务**: ${t}${meta}\n`;
    },

    // --- 流程图/Diagram ---
    diagram(block) {
      const title = renderRichText(block.data) || '流程图';
      const url = block.data?.diagram?.url || '';
      return url
        ? `\n> 🗺 **流程图**: [${title}](${url})\n`
        : `\n> 🗺 **流程图**: ${title}（需在飞书中查看）\n`;
    },

    // --- 思维导图 ---
    mindnote(block) {
      const title = renderRichText(block.data) || '思维导图';
      const url = block.data?.mindnote?.url || '';
      return url
        ? `\n> 🧠 **思维导图**: [${title}](${url})\n`
        : `\n> 🧠 **思维导图**: ${title}（需在飞书中查看）\n`;
    },

    // --- 公式块 ---
    equation(block) {
      const eq = block.data?.equation?.equation || '';
      return eq ? `\n$$\n${eq}\n$$\n` : '';
    },

    // --- 页面引用 ---
    page(block) {
      const title = block.data?.page?.title || renderRichText(block.data) || '';
      const url = block.data?.page?.url || '';
      if (!title && !url) return '';
      return url
        ? `\n> 📄 **页面引用**: [${title || url}](${url})\n`
        : `\n> 📄 **页面引用**: ${title}\n`;
    },

    // --- 嵌入网页/iframe ---
    iframe(block) {
      const url = block.data?.iframe?.url || block.data?.embed?.url || '';
      const title = renderRichText(block.data) || '嵌入内容';
      return url
        ? `\n> 🌐 **嵌入**: [${title}](${url})\n`
        : `\n> 🌐 **嵌入**: ${title}（需在飞书中查看）\n`;
    },

    // --- 聊天卡片 ---
    chat_card(block) {
      const title = renderRichText(block.data) || '聊天卡片';
      return `\n> 💬 **聊天卡片**: ${title}（需在飞书中查看）\n`;
    },

    // --- 分栏 ---
    grid(block, ctx) {
      const children = block.data?.children || [];
      if (children.length === 0) return '';
      let innerContent = '';
      for (const cid of children) {
        const cb = ctx.blockMap[cid];
        if (cb) {
          // 每列使用独立 counter 对象，避免列间有序列表编号互相干扰
          const colResult = processBlock(cid, ctx.blockMap, ctx.options, ctx.imageUrls, ctx.depth + 1, {});
          if (colResult.trim()) {
            innerContent += '<div class="column">\n\n' + colResult + '\n</div>\n\n';
          }
        }
      }
      // 所有列均为空时不输出空容器
      if (!innerContent.trim()) return '';
      return '\n<div class="grid">\n\n' + innerContent + '</div>\n\n';
    },

    // --- 附件（旧格式） ---
    attachment(block) {
      const name = block.data?.attachment?.name || '附件';
      const url = block.data?.attachment?.url || '';
      return url ? `\n📎 [${name}](${url})\n` : `\n📎 ${name}\n`;
    },

    // --- 兜底 ---
    _default(block) {
      const t = renderRichText(block.data);
      const type = block.data?.type || 'unknown';
      if (t) return `${t}\n`;
      // 有 children 的未知块，不输出占位（由递归处理 children）
      const hasChildren = block.data?.children && block.data.children.length > 0;
      return hasChildren ? '' : `\n<!-- 不支持的类型: ${type} -->\n`;
    },
  };

  // ---- 核心转换引擎 ----

  /**
   * 处理单个 block，递归处理子节点。
   * prevSiblingType: 前一个兄弟 block 的类型，用于检测有序列表边界。
   */
  function processBlock(blockId, blockMap, options, imageUrls, depth = 0, counter = {}, prevSiblingType = null, path = new Set()) {
    const block = blockMap[blockId];
    if (!block) return '';

    // 循环引用检测：当前 block 已在递归路径中 → 跳过防止栈溢出
    if (path.has(blockId)) return '';
    path.add(blockId);

    const type = block.data?.type || 'text';

    // 有序列表边界检测：当前 block 是 ordered 但前一个兄弟不是 ordered → 新列表开始
    if (type === 'ordered' && prevSiblingType !== 'ordered') {
      delete counter[depth];
    }

    const ctx = { blockMap, options, imageUrls, depth, counter };

    let result = '';

    const parser = BlockParser[type] || BlockParser._default;
    result += parser(block, ctx);

    // 递归处理子节点（table/gallery/grid 自行处理 children，跳过）
    const selfChildren = ['table', 'gallery', 'grid'];
    if (!selfChildren.includes(type)) {
      const children = block.data?.children || [];
      let childPrevType = null;
      for (const childId of children) {
        const childBlock = blockMap[childId];
        const childType = childBlock?.data?.type || 'text';
        result += processBlock(childId, blockMap, options, imageUrls, depth + 1, counter, childPrevType, path);
        childPrevType = childType;
      }
    }

    path.delete(blockId);
    return result;
  }

  /**
   * 收集所有待解析的子 Block ID（跨页引用检测）
   */
  function collectUnresolvedRefs(blockMap) {
    const unresolved = new Set();
    for (const [id, block] of Object.entries(blockMap)) {
      const children = block.data?.children || [];
      for (const childId of children) {
        if (!blockMap[childId]) {
          unresolved.add(childId);
        }
      }
    }
    return unresolved;
  }

  /**
   * 安全文件名清洗：移除路径穿越字符、控制字符、HTML敏感字符
   * 保留：中英文、数字、空格、常用标点（.,-_()[]）
   */
  function sanitizeFilename(name) {
    if (!name) return '';
    return name
      .replace(/[\\/:*?"<>|]/g, '_')   // 文件系统非法字符
      .replace(/[\x00-\x1f\x7f]/g, '') // 控制字符
      .replace(/\.\./g, '_')           // 路径穿越
      .replace(/^\.+/, '_')            // 开头点号（隐藏文件）
      .trim()
      .substring(0, 200);              // 最大长度限制
  }

  async function convertDoc(options) {
    _convertOpts = options;

    const docInfo = parseDocUrl();
    if (docInfo.error) {
      throw new Error(docInfo.error);
    }

    const endpoint = getApiEndpoint(docInfo);
    if (endpoint.error) {
      throw new Error(endpoint.error);
    }

    // 合并所有页面的 block_map
    const mergedBlockMap = {};
    const mergedBlockSeq = [];
    const seqIds = new Set(); // O(1) 去重（替代 Array.includes O(n)）

    let pageNum = 1;
    let cursor = '';
    const maxPages = 20; // 安全上限
    let firstTitle = '';
    let truncated = false;

    while (pageNum <= maxPages) {
      const url = new URL(endpoint.url);
      url.searchParams.set('id', docInfo.token);
      url.searchParams.set('mode', '7');
      url.searchParams.set('limit', '239');
      if (cursor) url.searchParams.set('cursor', cursor);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s 超时

      let resp;
      try {
        resp = await fetch(url, { credentials: 'include', signal: controller.signal });
      } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') {
          throw new Error(`API 请求超时 (30s)：网络过慢或飞书服务无响应`);
        }
        throw e;
      }
      clearTimeout(timeoutId);

      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          throw new Error(`API 认证失败 (${resp.status})：请确认已登录飞书并有权限访问此文档`);
        }
        if (resp.status === 429) {
          throw new Error(`API 频率限制 (429)：请求过于频繁，请稍后重试`);
        }
        throw new Error(`API 请求失败 (${resp.status}): ${resp.statusText}`);
      }

      // 检查 Content-Type 防止非 JSON 响应拖垮解析
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const preview = await resp.text().catch(() => '');
        throw new Error(`API 返回非 JSON 响应 (Content-Type: ${contentType || 'unknown'})，预览: ${preview.substring(0, 200)}`);
      }

      let json;
      try {
        json = await resp.json();
      } catch (e) {
        throw new Error(`API 响应 JSON 解析失败: ${e.message}`);
      }

      if (json.code !== undefined && json.code !== null && json.code !== 0) {
        throw new Error(`飞书 API 错误 (code=${json.code}): ${json.msg || '未知错误'}`);
      }

      // 提取页面数据
      const pageData = json.data?.page || json.data;
      const blockMap = pageData?.block_map || {};
      const blockSeq = pageData?.block_sequence || [];

      // 合并 block_map
      Object.assign(mergedBlockMap, blockMap);

      // 追加 block_sequence（O(1) 去重：Set + 顺序数组）
      for (const id of blockSeq) {
        if (!seqIds.has(id)) {
          seqIds.add(id);
          mergedBlockSeq.push(id);
        }
      }

      // 提取标题
      if (!firstTitle && pageData?.title) {
        firstTitle = pageData.title;
      }

      // 检查分页
      const hasMore = pageData?.has_more === true || pageData?.hasMore === true;
      const nextCursor = pageData?.next_cursor || pageData?.nextCursor ||
                         (pageData?.cursors && pageData.cursors[0]) || '';

      if (!hasMore || !nextCursor) break;

      // 超限截断检测：当前已处理完 maxPages 页，但还有下一页 → 标记截断
      if (pageNum >= maxPages) {
        truncated = true;
        break;
      }

      cursor = nextCursor;
      pageNum++;

      // 每次请求间隔 200ms 防止触发飞书 API 速率限制
      // 最大 20 页 = 最多额外 4 秒延迟，对用户体验影响极小
      await new Promise(r => setTimeout(r, 200));
    }

    // ---- 跨页引用解析：扫描未解析的子 Block ----
    // 注意：当前实现中，飞书 API 的 block_map 在同文档内应是完整的。
    // 仅需单次扫描：找出 blockMap 中被引用但不存在的 ID，插入占位文本。
    // （多次循环无意义：第一次已将所有缺失 ID 填为占位，后续 unresolved.size 永远为 0）
    const unresolved = collectUnresolvedRefs(mergedBlockMap);
    let unresolvedCount = unresolved.size;
    if (unresolved.size > 0) {
      for (const uid of unresolved) {
        mergedBlockMap[uid] = {
          data: {
            type: 'text',
            initialAttributedTexts: [{
              text: `[⚠ 无法解析的引用内容 (ID: ${uid.slice(-8)})]`,
            }],
          },
        };
      }
    }

    // ---- 构建 Markdown ----
    let allLines = [];
    const imageUrls = [];
    const seen = new Set();

    let prevSiblingType = null;
    for (const blockId of mergedBlockSeq) {
      if (seen.has(blockId)) continue;
      seen.add(blockId);

      const block = mergedBlockMap[blockId];
      const blockType = block?.data?.type || 'text';

      const line = processBlock(blockId, mergedBlockMap, options, imageUrls, 0, {}, prevSiblingType);
      if (line) allLines.push(line);
      prevSiblingType = blockType;
    }

    // 清理输出
    let markdown = allLines.join('');
    markdown = markdown.replace(/\n{3,}/g, '\n\n');
    markdown = markdown.replace(/\n{2,}---\n{2,}/g, '\n\n---\n\n');
    markdown = markdown.trim();

    if (!firstTitle) {
      firstTitle = sanitizeFilename(document.title) || 'untitled';
    }

    return {
      markdown,
      title: firstTitle,
      pages: pageNum,
      imageUrls,
      unresolvedRefs: unresolvedCount,
      truncated,
    };
  }

  // ---- 注入到页面：按钮 + 浮窗 ----
  function injectUI() {
    if (document.getElementById('__fs_converter_btn')) return;

    const container = document.createElement('div');
    container.id = '__fs_converter_btn';
    container.innerHTML = `
      <div style="
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 9999;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      ">
        <button id="__fs_convert_btn" style="
          background: linear-gradient(135deg, #6B8CFF, #4A6CF7);
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 24px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(74,108,247,0.4);
          transition: transform 0.15s, box-shadow 0.15s;
        ">📄 转换为 Markdown</button>
        <div id="__fs_status" style="
          display: none;
          margin-top: 8px;
          padding: 8px 12px;
          background: white;
          border-radius: 8px;
          font-size: 12px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          max-width: 280px;
        "></div>
      </div>
    `;
    document.body.appendChild(container);

    const btn = document.getElementById('__fs_convert_btn');
    const statusEl = document.getElementById('__fs_status');

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '⏳ 转换中...';
      statusEl.style.display = 'block';
      statusEl.textContent = '正在读取文档...';
      statusEl.style.color = '#1565C0';

      try {
        const result = await convertDoc({
          tables: true,
          images: true,
          links: true,
          debug: false,
        });

        const safeTitle = sanitizeFilename(result.title) || 'untitled';
        const blob = new Blob([result.markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${safeTitle}.md`;
        a.click();
        URL.revokeObjectURL(url);

        statusEl.style.color = '#2E7D32';
        // 使用 textContent 避免 XSS（API 返回的 title 可能含恶意字符）
        const statusLines = [
          `✅ 转换完成！`,
          `标题: ${result.title}`,
          `页数: ${result.pages}${result.truncated ? ' (已达上限)' : ''}`,
          `大小: ${(result.markdown.length / 1024).toFixed(1)} KB`,
          `图片: ${result.imageUrls.length} 张`,
        ];
        if (result.unresolvedRefs > 0) {
          statusLines.push(`⚠ 跨页引用: ${result.unresolvedRefs} 处`);
        }
        while (statusEl.firstChild) statusEl.removeChild(statusEl.firstChild);
        statusLines.forEach((line, i) => {
          if (i > 0) statusEl.appendChild(document.createElement('br'));
          statusEl.appendChild(document.createTextNode(line));
        });

        btn.textContent = '📄 再次转换';
      } catch (err) {
        statusEl.style.color = '#C62828';
        statusEl.textContent = `❌ ${err.message}`;
        btn.textContent = '🔄 重试';
      } finally {
        btn.disabled = false;
      }
    });

    // 鼠标悬停效果
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.05)';
      btn.style.boxShadow = '0 6px 16px rgba(74,108,247,0.5)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)';
      btn.style.boxShadow = '0 4px 12px rgba(74,108,247,0.4)';
    });
  }

  // ---- 消息监听（供 popup 调用） ----
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'get_doc_info') {
      const docInfo = parseDocUrl();
      sendResponse({
        title: document.title || 'untitled',
        url: window.location.href,
        token: docInfo.token,
        type: docInfo.type,
        host: docInfo.host,
        error: docInfo.error,
      });
      return true;
    }

    if (request.action === 'convert') {
      const opts = {
        tables: request.options?.tables !== false,
        images: request.options?.images !== false,
        links: request.options?.links !== false,
        debug: request.options?.debug === true,
      };

      convertDoc(opts).then(result => {
        sendResponse({
          markdown: result.markdown,
          title: result.title,
          imageUrls: result.imageUrls,
          pages: result.pages,
          unresolvedRefs: result.unresolvedRefs || 0,
          truncated: result.truncated || false,
        });
      }).catch(err => {
        sendResponse({ error: err.message });
      });

      return true; // 保持通道开启
    }
  });

  // ---- 初始化 ----
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    injectUI();
  } else {
    document.addEventListener('DOMContentLoaded', injectUI);
  }

})();
