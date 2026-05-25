// ============================================================
// 飞书文档转换器 - Content Script (v2.9)
// 功能：富文本渲染、多路径API、跨页引用解析、全块类型支持
// v2.4-2.8 修复历史见 CHANGELOG
// v2.9 新增：URL全局清洗(sanitizeUrl, 阻止javascript:/data:等危险协议)、P0×5修复(代码块保护/depth 4→8/表格内联代码保护/getPlainText扩展/跨子树循环检测)、P1 URL安全(9个块类型统一清洗)、P0鲁棒性(消息超时/block上限/空数据检测/占位冲突)
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

        // 行内代码：内联样式包裹在 <code> 标签内，避免 Markdown 语义冲突
        if (style.inlineCode) {
          let inner = text;

          // 粗体+斜体（HTML 保证 Markdown 代码块内也可展示格式）
          if (style.bold && style.italic) {
            inner = `<em><strong>${inner}</strong></em>`;
          } else if (style.bold) {
            inner = `<strong>${inner}</strong>`;
          } else if (style.italic) {
            inner = `<em>${inner}</em>`;
          }

          // 删除线
          if (style.strikethrough) {
            inner = `<s>${inner}</s>`;
          }

          // 下划线
          if (style.underline) {
            inner = `<u>${inner}</u>`;
          }

          text = `<code>${inner}</code>`;

          // 不处理链接（inline code 为字面量，链接无意义）
        } else {
          // 链接优先（可能是带链接的文本）
          if (style.link?.url && _convertOpts.links !== false) {
            text = `[${text}](${sanitizeUrl(style.link.url)})`;
          }

          // 粗体+斜体组合（Markdown: ***text***）
          if (style.bold && style.italic) {
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
        }

        // 文字颜色（非默认颜色时添加 emoji 标注）
        const rawFg = (style.foreColor || style.textColor || style.color || '').toLowerCase();
        const fgColor = rawFg.startsWith('background_') ? '' : rawFg.replace(/ /g, '_');
        if (fgColor && fgColor !== 'default' && fgColor !== 'black' && FEISHU_COLORS[fgColor]) {
          text = `${FEISHU_COLORS[fgColor]} ${text}`;
        }

        // 背景高亮
        const bgColor = (style.backColor || style.backgroundColor || style.bgColor || '').toLowerCase().replace(/ /g, '_');
        const bgKey = bgColor ? bgColor + '_bg' : '';
        if (bgKey && FEISHU_COLORS[bgKey]) {
          text = `==${text}==`;
        }

        return text;
      }

      // @文档
      case 'mentionDoc': {
        const title = el.mentionDoc?.title || '文档';
        const url = sanitizeUrl(el.mentionDoc?.url || '');
        return url !== '#' ? `[📄 ${title}](${url})` : `📄 ${title}（无可用链接）`;
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
        if (el.mentionDate || el.type === 'date' || el._type === 'mentionDate')
          return el.mentionDate?.date || el.date || '';
        if (el.inlineEquation || el.type === 'equation' || el._type === 'inlineEquation')
          return el.inlineEquation?.equation || el.equation || '';
        if (el.emoji || el.type === 'emoji' || el._type === 'emoji')
          return el.emoji?.text || el.text || '';
        return el.text || '';
      }).join('');
    }).join('');
  }

  // ---- 文档 URL 解析 ----

  function parseDocUrl() {
    const url = window.location.href;
    const host = window.location.host;

    const isFeishu = /\.feishu\.cn$/.test(host) || /\.larksuite\.com$/.test(host);
    if (!isFeishu) {
      return { type: 'unknown', token: null, host: null, error: '非飞书页面' };
    }

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
        return { type: p.type, token: match[1], host, error: null };
      }
    }

    return { type: 'unknown', token: null, host, error: '无法识别文档类型' };
  }

  function getApiEndpoint(docInfo) {
    const base = `https://${docInfo.host}`;

    if (docInfo.type === 'wiki' || docInfo.type === 'space') {
      return {
        url: `${base}/space/api/docx/pages/client_vars`,
        needsTypeParam: false,
      };
    }

    if (docInfo.type === 'docx') {
      return {
        url: `${base}/space/api/docx/pages/client_vars`,
        needsTypeParam: false,
      };
    }

    if (docInfo.type === 'mindnote' || docInfo.type === 'sheet' || docInfo.type === 'bitable') {
      return { url: null, error: `${docInfo.type} 类型暂不支持 API 解析` };
    }

    return {
      url: `${base}/space/api/docx/pages/client_vars`,
      needsTypeParam: false,
    };
  }

  // ---- 块解析器 ----

  const BlockParser = {

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

    text(block) {
      const t = renderRichText(block.data);
      return t ? `${t}\n` : '';
    },

    bullet(block, ctx) {
      const t = renderRichText(block.data);
      const indent = '  '.repeat(Math.min(ctx.depth, 8));
      return t ? `${indent}- ${t}\n` : '';
    },
    ordered(block, ctx) {
      const t = renderRichText(block.data);
      if (!t) return '';
      const start = block.data?.ordered?.start || 1;
      if (!(ctx.depth in ctx.counter)) ctx.counter[ctx.depth] = (start > 0 ? start : 1) - 1;
      ctx.counter[ctx.depth]++;
      const indent = '  '.repeat(Math.min(ctx.depth, 8));
      return `${indent}${ctx.counter[ctx.depth]}. ${t}\n`;
    },

    code(block) {
      const code = getPlainText(block.data) || '';
      const langRaw = (block.data?.code?.style?.language || block.data?.code?.language || block.data?.style?.language || '').toLowerCase();
      const lang = LANG_ALIAS[langRaw] || langRaw;
      if (!code.trim()) return '';
      return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    },

    quote(block) {
      const t = renderRichText(block.data);
      if (!t) return '';
      const lines = t.split('\n').map(l => l ? `> ${l}` : '>').join('\n');
      return `\n${lines}\n`;
    },

    callout(block) {
      const t = renderRichText(block.data);
      const color = block.data?.callout?.color || '';
      const emoji = block.data?.callout?.emoji || '';
      const parts = [];
      if (emoji) parts.push(emoji);
      if (color) parts.push(`[${color.toUpperCase()}]`);
      const header = parts.length > 0 ? `**${parts.join(' ')}**` : '**Note**';
      return t ? `\n> ${header}\n${t.split('\n').map(l => l ? `> ${l}` : '>').join('\n')}\n` : '';
    },

    divider() {
      return '\n---\n';
    },

    table(block, ctx) {
      if (ctx.options?.tables === false) {
        return '\n[表格已省略]\n';
      }
      const bm = ctx.blockMap;
      const children = block.data?.children || [];
      if (children.length === 0) return '';

      const headerRowProp = block.data?.table?.header_row ?? block.data?.header_row ?? true;
      let headerRows = 0;
      if (headerRowProp === true) headerRows = 1;
      else if (typeof headerRowProp === 'number') headerRows = headerRowProp;

      const rows = [];

      for (const rowId of children) {
        const rowBlock = bm[rowId];
        if (!rowBlock || rowBlock.data?.type !== 'table_row') continue;

        const rowChildren = rowBlock.data.children || [];
        const cells = [];

        for (const cellId of rowChildren) {
            const cellBlock = bm[cellId];
            if (!cellBlock) { cells.push(''); continue; }

            const cellChildren = cellBlock.data?.children || [];
            let inner = '';
            if (cellChildren.length > 0) {
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
              inner = renderRichText(cellBlock.data);
            }

            const codeParts = [];
            let escaped = inner.replace(/`[^`]*`/g, (m) => {
              codeParts.push(m);
              return `\x00IDX${codeParts.length - 1}\x00`;
            });
            escaped = escaped
              .replace(/\\/g, '\\\\')
              .replace(/\|/g, '\\|')
              .replace(/\*/g, '\\*')
              .replace(/_/g, '\\_')
              .replace(/\[/g, '\\[')
              .replace(/\]/g, '\\]')
              .replace(/~/g, '\\~')
              .replace(/\n/g, ' ');
            escaped = escaped.replace(/\x00IDX(\d+)\x00/g, (_, i) => codeParts[parseInt(i)]);
            cells.push(escaped);
          }

        rows.push(cells);
      }

      if (rows.length === 0) return '';

      let md = '\n';
      const colCount = Math.max(...rows.map(r => r.length), 1);

      for (const row of rows) {
        while (row.length < colCount) row.push('');
      }

      for (let i = 0; i < rows.length; i++) {
        md += '| ' + rows[i].join(' | ') + ' |\n';
        if (i === headerRows - 1 && headerRows > 0 && headerRows < rows.length) {
          md += '| ' + Array(colCount).fill('---').join(' | ') + ' |\n';
        }
      }

      return md + '\n';
    },

    image(block, ctx) {
      const rawSrc = block.data?.image?.source_url ||
                  block.data?.file?.source_url || '';
      const src = sanitizeUrl(rawSrc);
      const alt = renderRichText(block.data) || '图片';
      if (src === '#') return `\n[图片: ${alt}]\n`;
      if (ctx.options?.images === false) {
        return `\n[图片: ${alt}]\n`;
      }
      if (ctx.imageUrls) {
        ctx.imageUrls.push({ url: rawSrc, alt });
      }
      return `\n![${alt}](${src})\n`;
    },

    todo(block) {
      const t = renderRichText(block.data);
      const done = block.data?.todo?.done || false;
      const assignee = block.data?.todo?.assignee?.name || '';
      const extra = assignee ? ` *(负责人: @${assignee})*` : '';
      return `- [${done ? 'x' : ' '}] ${t || '待办事项'}${extra}\n`;
    },

    link_card(block) {
      const rawUrl = block.data?.link_card?.url || block.data?.link?.url || '';
      const url = sanitizeUrl(rawUrl);
      const title = block.data?.link_card?.title || renderRichText(block.data) || rawUrl;
      const desc = block.data?.link_card?.description || '';
      const thumb = sanitizeUrl(block.data?.link_card?.thumbnail || '');
      if (url === '#') return title ? `\n> 🔗 ${title}\n` : '';
      let md = `\n> **🔗 [${title}](${url})**\n`;
      if (desc) md += `> ${desc}\n`;
      if (thumb !== '#') md += `> ![thumb](${thumb})\n`;
      return md + '\n';
    },

    file(block) {
      const name = block.data?.file?.name || renderRichText(block.data) || '附件';
      const url = sanitizeUrl(block.data?.file?.url || block.data?.file?.source_url || '');
      return url !== '#' ? `\n📎 [${name}](${url})\n` : `\n📎 ${name}\n`;
    },

    bitable(block) {
      const title = renderRichText(block.data) || '多维表格';
      const url = sanitizeUrl(block.data?.bitable?.url || '');
      return url !== '#' ? `\n> 📊 **多维表格**: [${title}](${url})\n` : `\n> 📊 **多维表格**: ${title}\n`;
    },

    gallery(block, ctx) {
      const children = block.data?.children || [];
      if (children.length === 0) return '';
      let images = '';
      for (const cid of children) {
        const cb = ctx.blockMap[cid];
        if (cb && cb.data?.type === 'image') {
          const rawSrc = cb.data?.image?.source_url || cb.data?.file?.source_url || '';
          const src = sanitizeUrl(rawSrc);
          if (src !== '#') {
            if (ctx.imageUrls) ctx.imageUrls.push({ url: rawSrc, alt: 'gallery' });
            images += `![gallery](${src})\n\n`;
          }
        }
      }
      if (!images.trim()) return '';
      return '\n<div class="gallery">\n\n' + images + '</div>\n\n';
    },

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

    diagram(block) {
      const title = renderRichText(block.data) || '流程图';
      const url = sanitizeUrl(block.data?.diagram?.url || '');
      return url !== '#'
        ? `\n> 🗺 **流程图**: [${title}](${url})\n`
        : `\n> 🗺 **流程图**: ${title}（需在飞书中查看）\n`;
    },

    mindnote(block) {
      const title = renderRichText(block.data) || '思维导图';
      const url = sanitizeUrl(block.data?.mindnote?.url || '');
      return url !== '#'
        ? `\n> 🧠 **思维导图**: [${title}](${url})\n`
        : `\n> 🧠 **思维导图**: ${title}（需在飞书中查看）\n`;
    },

    equation(block) {
      const eq = block.data?.equation?.equation || '';
      return eq ? `\n$$\n${eq}\n$$\n` : '';
    },

    page(block) {
      const title = block.data?.page?.title || renderRichText(block.data) || '';
      const url = sanitizeUrl(block.data?.page?.url || '');
      if (!title && url === '#') return '';
      return url !== '#'
        ? `\n> 📄 **页面引用**: [${title || url}](${url})\n`
        : `\n> 📄 **页面引用**: ${title}\n`;
    },

    iframe(block) {
      const url = sanitizeUrl(block.data?.iframe?.url || block.data?.embed?.url || '');
      const title = renderRichText(block.data) || '嵌入内容';
      return url !== '#'
        ? `\n> 🌐 **嵌入**: [${title}](${url})\n`
        : `\n> 🌐 **嵌入**: ${title}（需在飞书中查看）\n`;
    },

    chat_card(block) {
      const title = renderRichText(block.data) || '聊天卡片';
      return `\n> 💬 **聊天卡片**: ${title}（需在飞书中查看）\n`;
    },

    grid(block, ctx) {
      const children = block.data?.children || [];
      if (children.length === 0) return '';
      let innerContent = '';
      for (const cid of children) {
        const cb = ctx.blockMap[cid];
        if (cb) {
          const colResult = processBlock(cid, ctx.blockMap, ctx.options, ctx.imageUrls, ctx.depth + 1, {});
          if (colResult.trim()) {
            innerContent += '<div class="column">\n\n' + colResult + '\n</div>\n\n';
          }
        }
      }
      if (!innerContent.trim()) return '';
      return '\n<div class="grid">\n\n' + innerContent + '</div>\n\n';
    },

    attachment(block) {
      const name = block.data?.attachment?.name || '附件';
      const url = sanitizeUrl(block.data?.attachment?.url || '');
      return url !== '#' ? `\n📎 [${name}](${url})\n` : `\n📎 ${name}\n`;
    },

    _default(block) {
      const t = renderRichText(block.data);
      const type = block.data?.type || 'unknown';
      if (t) return `${t}\n`;
      const hasChildren = block.data?.children && block.data.children.length > 0;
      return hasChildren ? '' : `\n<!-- 不支持的类型: ${type} -->\n`;
    },
  };

  // ---- 核心转换引擎 ----

  function processBlock(blockId, blockMap, options, imageUrls, depth = 0, counter = {}, prevSiblingType = null, path = new Set()) {
    const block = blockMap[blockId];
    if (!block) return '';

    if (path.has(blockId)) return '';
    path.add(blockId);

    const type = block.data?.type || 'text';

    if (type === 'ordered' && prevSiblingType !== 'ordered') {
      delete counter[depth];
    }

    const ctx = { blockMap, options, imageUrls, depth, counter };

    let result = '';

    const parser = BlockParser[type] || BlockParser._default;
    result += parser(block, ctx);

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

  function sanitizeFilename(name) {
    if (!name) return '';
    return name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/\.\./g, '_')
      .replace(/^\.+/, '_')
      .trim()
      .substring(0, 200);
  }

  function sanitizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '#';
    const url = rawUrl.trim();
    if (!url) return '#';

    if (/^[#\/]/.test(url)) return url;

    if (/^data:image\/(png|jpeg|gif|webp|bmp|tiff);/i.test(url)) return url;

    const m = url.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):/);
    if (m) {
      const protocol = m[1].toLowerCase();
      const allowed = ['http', 'https', 'ftp', 'mailto'];
      if (!allowed.includes(protocol)) return '#';
    }
    return url;
  }

  async function convertDoc(options) {
    _convertOpts = options;
    try {

    const docInfo = parseDocUrl();
    if (docInfo.error) {
      throw new Error(docInfo.error);
    }

    const endpoint = getApiEndpoint(docInfo);
    if (endpoint.error) {
      throw new Error(endpoint.error);
    }

    const mergedBlockMap = {};
    const mergedBlockSeq = [];
    const seqIds = new Set();

    let pageNum = 1;
    let cursor = '';
    const maxPages = 20;
    const MAX_BLOCKS = 5000;
    let firstTitle = '';
    let truncated = false;

    while (pageNum <= maxPages) {
      const url = new URL(endpoint.url);
      url.searchParams.set('id', docInfo.token);
      url.searchParams.set('mode', '7');
      url.searchParams.set('limit', '239');
      if (cursor) url.searchParams.set('cursor', cursor);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

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

      const pageData = json.data?.page || json.data;

      if (!pageData || (Object.keys(pageData).length === 0)) {
        if (pageNum === 1) {
          throw new Error('文档数据为空：飞书 API 返回成功 code 但无页面内容，请确认文档是否有效或权限是否正确');
        }
        console.warn(`[飞书转换器] 第 ${pageNum} 页数据为空，跳过`);
        break;
      }

      const blockMap = pageData.block_map || {};
      const blockSeq = pageData.block_sequence || [];

      Object.assign(mergedBlockMap, blockMap);

      if (Object.keys(mergedBlockMap).length > MAX_BLOCKS) {
        truncated = true;
        console.warn(`[飞书转换器] block 数量超过安全上限 (${MAX_BLOCKS})，已截断。建议分拆文档。`);
        break;
      }

      for (const id of blockSeq) {
        if (!seqIds.has(id)) {
          seqIds.add(id);
          mergedBlockSeq.push(id);
        }
      }

      if (!firstTitle && pageData?.title) {
        firstTitle = pageData.title;
      }

      const hasMore = pageData?.has_more === true || pageData?.hasMore === true;
      const nextCursor = pageData?.next_cursor || pageData?.nextCursor ||
                         (pageData?.cursors && pageData.cursors[0]) || '';

      if (!hasMore || !nextCursor) break;

      if (pageNum >= maxPages) {
        truncated = true;
        break;
      }

      cursor = nextCursor;
      pageNum++;

      await new Promise(r => setTimeout(r, 200));
    }

    const unresolved = collectUnresolvedRefs(mergedBlockMap);
    let unresolvedCount = unresolved.size;
    if (unresolved.size > 0) {
      for (const uid of unresolved) {
        if (mergedBlockMap[uid]) continue;
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

    let allLines = [];
    const imageUrls = [];
    const seen = new Set();
    const sharedPath = new Set();

    let prevSiblingType = null;
    for (const blockId of mergedBlockSeq) {
      if (seen.has(blockId)) continue;
      seen.add(blockId);

      const block = mergedBlockMap[blockId];
      const blockType = block?.data?.type || 'text';

      const line = processBlock(blockId, mergedBlockMap, options, imageUrls, 0, {}, prevSiblingType, sharedPath);
      if (line) allLines.push(line);
      prevSiblingType = blockType;
    }

    let markdown = allLines.join('');

    const codeBlocks = [];
    markdown = markdown.replace(/```[\s\S]*?```/g, (match) => {
      codeBlocks.push(match);
      return `\n__CODEBLOCK_${codeBlocks.length - 1}__\n`;
    });

    markdown = markdown.replace(/\n{3,}/g, '\n\n');
    markdown = markdown.replace(/\n{2,}---\n{2,}/g, '\n\n---\n\n');

    markdown = markdown.replace(/__CODEBLOCK_(\d+)__/g, (_, i) => codeBlocks[parseInt(i)]);

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
    } finally {
      _convertOpts = null;
    }
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

      const CONVERT_TIMEOUT_MS = 60000;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('转换超时 (60s)')), CONVERT_TIMEOUT_MS)
      );

      const safeSend = (data) => {
        try { sendResponse(data); } catch (_) { /* popup 已关闭，忽略 */ }
        if (chrome.runtime?.lastError) { /* 通道已关闭，静默忽略 */ }
      };

      Promise.race([convertDoc(opts), timeoutPromise])
        .then(result => {
          safeSend({
            markdown: result.markdown,
            title: result.title,
            imageUrls: result.imageUrls,
            pages: result.pages,
            unresolvedRefs: result.unresolvedRefs || 0,
            truncated: result.truncated || false,
          });
        })
        .catch(err => {
          safeSend({ error: err.message });
        });

      return true;
    }
  });

  // ---- 初始化 ----
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    injectUI();
  } else {
    document.addEventListener('DOMContentLoaded', injectUI);
  }

})();
