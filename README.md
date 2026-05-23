# 飞书文档转换器 - Chrome 扩展

> 一键将飞书文档转换为 Markdown 格式，支持表格、图片、嵌套列表。

## 安装方法

1. 打开 Chrome 浏览器
2. 进入 `chrome://extensions/`
3. 右上角开启「开发者模式」
4. 点击「加载已解压的扩展程序」
5. 选择本目录 `feishu-doc-converter/`

## 使用方法

1. 打开任意飞书文档页面（如 `https://xxx.feishu.cn/wiki/...`）
2. 点击工具栏中的扩展图标 📄
3. 确认文档标题正确
4. 勾选需要保留的内容（表格/图片/链接）
5. 点击「开始转换」
6. 转换完成后可点击「复制到剪贴板」

## 文件结构

```
feishu-doc-converter/
├── manifest.json       # 扩展配置（MV3）
├── popup.html         # 弹出窗口 UI
├── popup.js           # 弹出窗口逻辑
├── content.js         # 注入飞书页面的核心转换引擎
├── background.js      # 后台下载处理
├── generate_icons.py  # 图标生成脚本
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 支持的块类型

| 飞书块类型 | Markdown 输出 |
|---|---|
| heading1-4 | # ## ### #### |
| text | 普通段落 |
| bullet | - 无序列表（支持嵌套） |
| ordered | 1. 有序列表（支持嵌套） |
| code | \`\`\` 代码块 |
| callout | > 引用 |
| divider | --- 分隔线 |
| table | \| 表格 \| |
| image | ![alt](url) |
| todo | - [ ] / - [x] |
| link_card | 🔗 [url](url) |
| file | 📎 [filename](url) |

## 注意事项

- 需要已登录飞书账号（扩展利用页面已有 Cookie）
- 大文档（1000+ 块）可能需要翻页，扩展自动处理
- 图片仅保存链接，不自动下载（避免请求过量）

## 与 Python 脚本的关系

`parse_all.py` 是离线版本（需要提前保存 API 响应），本扩展是在线版本（直接在浏览器中抓取）。
