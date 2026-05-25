# 飞书文档转换器 - Chrome 扩展 v2.0

> 一键将飞书文档转换为 Markdown 格式。富文本渲染、多路径API、跨页引用解析、后台持久转换。

## 安装方法

1. 打开 Chrome 浏览器
2. 进入 `chrome://extensions/`
3. 右上角开启「开发者模式」
4. 点击「加载已解压的扩展程序」
5. 选择本目录 `feishu-doc-converter/`

## 使用方法

### 方式一：在飞书页面直接转换
1. 打开任意飞书文档页面（wiki/docx/docs/space）
2. 点击页面右下角浮动按钮「📄 转换为 Markdown」
3. 自动下载 `.md` 文件

### 方式二：通过扩展 Popup
1. 打开飞书文档 → 点击工具栏扩展图标 📄
2. 确认文档信息，勾选选项，点击「开始转换」
3. 可选择：下载 .md、📦图片+ZIP打包、📝导出DOCX

### 方式三：粘贴 URL 解析
1. 复制飞书文档链接
2. 点击扩展图标，粘贴到 URL 输入框
3. 点击「打开」→ 自动导航并加载文档
4. 点击「开始转换」

## 文件结构

```
feishu-doc-converter/
├── manifest.json       # 扩展配置（MV3）
├── popup.html          # 弹出窗口 UI（转换+历史双Tab）
├── popup.js            # 弹出窗口逻辑（URL导航/ZIP/DOCX/历史）
├── content.js          # 核心转换引擎（富文本+多路径+跨页）
├── background.js       # 后台持久转换+下载代理
├── jszip.min.js        # JSZip 图片打包库
├── generate_icons.py   # 图标生成脚本
└── icons/              # 扩展图标
```

## 支持的块类型（25种）

| 飞书块类型 | 输出格式 |
|---|---|
| heading1-4 | 标题 # ## ### #### |
| text | 富文本段落（粗体/斜体/删除线/行内代码/链接） |
| bullet / ordered | 有序/无序列表（支持嵌套） |
| code | 代码块（含语言标签） |
| quote | > 引用块 |
| callout | 高亮块（含颜色+emoji） |
| divider | --- 分割线 |
| table | Markdown 表格（含表头） |
| image | 图片链接（支持下载打包） |
| todo | 待办事项（含负责人/截止日期） |
| link_card | 链接卡片（标题+描述+缩略图） |
| file / attachment | 文件附件 |
| bitable | 多维表格引用 |
| gallery | 图片组 |
| task | 任务（含负责人/状态/截止日期） |
| diagram | 流程图 |
| mindnote | 思维导图 |
| equation | 公式块 $$ |
| page | 页面引用 |
| iframe | 嵌入网页 |
| chat_card | 聊天卡片 |
| grid | 分栏布局 |

## 富文本内联支持（10+ 类型）

| 格式 | 示例 |
|---|---|
| 粗体/斜体 | **bold** / *italic* |
| 删除线/下划线 | ~~strikethrough~~ / `<u>`underline`</u>` |
| 行内代码 | \`code\` |
| 链接 | [text](url) |
| @文档 | [📄 文档名](url) |
| @用户 | @用户名 |
| 日期 | 📅 2025-01-01 |
| 公式 | $E=mc^2$ |
| Emoji | :emoji_name: |

## 多路径 API 支持

| URL 模式 | 文档类型 | 支持状态 |
|---|---|---|
| `/wiki/TOKEN` | 知识空间 | ✅ |
| `/docx/TOKEN` | 新版文档 | ✅ |
| `/docs/TOKEN` | 旧版文档 | ✅ |
| `/space/TOKEN` | 空间页面 | ✅ |
| `/mindnotes/TOKEN` | 思维导图 | ⚠ 引用 |
| `/sheets/TOKEN` | 表格 | ⚠ 引用 |
| `/base/TOKEN` | 多维表格 | ⚠ 引用 |

## v2.0 核心改进

- **富文本引擎**：完整解析 elements[] 数组，支持 10+ 种内联元素
- **动态域名**：自动从页面 URL 提取，支持任意飞书租户
- **多路径 API**：wiki/docx/docs/space 四类文档均支持
- **跨页引用解析**：子 block 引用断裂自动修补
- **URL 粘贴导航**：贴链接→自动打开→转换，无需手动跳转
- **后台持久转换**：关闭 popup 不中断，background.js 托管
- **XSS 安全修复**：DOCX 导出全量 HTML 实体转义
- **Tab 切换**：转换/历史双面板
- **25 种块类型**：新增 quote/grid/bitable/gallery/task/diagram/mindnote/equation/page/iframe/chat_card/attachment

## 注意事项

- 需要已登录飞书账号（扩展利用页面已有 Cookie）
- 大文档（1000+ 块）自动翻页，最大 20 页
- API 限流保护：每 5 页延迟 500ms
- `mindnote/sheet/bitable` 类型仅支持引用，无法解析内容
