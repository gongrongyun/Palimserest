# Palimserest

An Obsidian plugin for looking up English words in reading excerpts. Hover until a word is highlighted, then click it for brief English definitions, IPA, and audio playback.

在 Obsidian 桌面端的阅读视图和实时预览里，悬停至单词高亮后点击查词。卡片按词性显示英英短释义和 IPA，点播放键听发音。

## 安装

需要 Obsidian 桌面端 1.11.4 或以上版本。

从 GitHub 获取源码时，可以在 Windows 的项目目录运行下面的命令，用本机语音生成离线试用所需的 `demo-audio/`。安装包内已包含这些试听文件。

```powershell
powershell -NoProfile -File .\generate-demo-audio.ps1
```

1. 将安装包解压到库的 `.obsidian/plugins/`，确认 `.obsidian/plugins/palimserest/manifest.json` 存在。也可以把 `manifest.json`、`main.js`、`styles.css` 和 `demo-audio/` 复制到该目录。
2. 打开「设置 → 第三方插件」。如果库处于受限模式，先启用第三方插件，再重新加载列表并启用 **Palimserest**。
3. 新建一篇笔记，粘贴下面的内容。在阅读视图和实时预览里，将鼠标停在 `subtle`、`yield`、`record`、`ran` 或 `run` 上，等单词高亮后点击。

```markdown
---
english-hover: true
---

A subtle change altered the yield. The team kept a detailed record.

> They ran another trial to see if the same test would run again.
```

默认的内置样例包含上面的五个词和本地合成语音。试听 `record` 的名词和动词时，样例分别读出 “a record” 和 “to record”。

## 联网词典

得到 Merriam-Webster 的使用许可后，在插件设置中切换词典来源，并用 Obsidian 的密钥存储选择 **Learner’s Dictionary API Key**。联网查询会将点击的单词和接口所需的 Key 发送给 Merriam-Webster。词典录音在点播时加载，词条卡片标注来源。 [官方接口](https://dictionaryapi.com/products/api-learners-dictionary) · [使用条款](https://dictionaryapi.com/info/terms-of-service)

联网查询结果保存在当前库的本机缓存中。默认最多保存 512 条，从查询完成起保留 168 小时（7 天），重启后仍可复用。两个上限都可在设置里调整，任一项填 0 即关闭缓存。查无词条的结果也会缓存，失败或超时的请求可以重试。

设置页的「今日词典请求次数」按本机日期统计本库实际发出的查词请求。每次发送计一次，缓存命中、离线样例和录音点播不计入。计数从 0.1.1 开始，重启后仍保留当天的数值。

## 使用

- 把布尔属性 `english-hover: true` 加到要查词的笔记或摘抄模板。正文、引用和列表可以触发，链接、代码和公式会跳过。
- 在词上停留约 300 毫秒，单词背景变色，鼠标显示为手形。此时点击才会查询。较慢的查询会显示「查询中」。鼠标可以移入卡片点播，离开后卡片收起。滚动、拖选、切页或按 `Esc` 会取消高亮并收起卡片。
- 在「设置 → Palimserest → 查词与缓存」可调整悬停时长、卡片释义上限、单词长度上限、加载提示延迟、卡片关闭延迟、联网查询超时、缓存词条上限和缓存有效期。
- 词典返回不同词形时，卡片会标出词条原形。音标和录音随各自的词形或词性显示。

插件由 Obsidian 直接加载仓库中的 JavaScript 和样式，无需构建。
