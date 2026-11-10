# Palimserest

An Obsidian plugin for looking up English words and short selections. Click a highlighted word or hover over a selection and use the lookup button for brief English definitions, IPA, and audio playback when available.

在 Obsidian 桌面端的阅读视图和实时预览里，可以点击悬停高亮的单词，也可以悬停选区后点按钮查词。卡片按词性显示英英短释义，有发音的词条可查看 IPA 或播放录音。

## 安装

需要 Obsidian 桌面端 1.11.4 或以上版本。

从 GitHub 获取源码时，可以在 Windows 的项目目录运行下面的命令，用本机语音生成离线试用所需的 `demo-audio/`。安装包内已包含这些试听文件。

```powershell
powershell -NoProfile -File .\generate-demo-audio.ps1
```

1. 将安装包解压到库的 `.obsidian/plugins/`，确认 `.obsidian/plugins/palimserest/manifest.json` 存在。也可以把 `manifest.json`、`main.js`、`styles.css`、`locales/` 和 `demo-audio/` 复制到该目录。
2. 打开「设置 → 第三方插件」。如果库处于受限模式，先启用第三方插件，再重新加载列表并启用 **Palimserest**。
3. 新建一篇笔记，粘贴下面的内容。悬停 `subtle` 等待高亮后点击，或选中 `replay` 中的 `play` 或短语 `take off`，松开鼠标后在选区内移动并停留，点击「查词」。

```markdown
---
english-hover: true
---

A subtle change altered the yield. The team kept a detailed record.

> They ran another trial to see if the same test would run again.

We watched the replay of the plane as it began to take off.
```

默认的内置样例收录 `subtle`、`yield`、`record`、`ran`、`run`、`play` 和 `take off`。前五个词可试听本地合成发音。`record` 的名词和动词样例分别读出 “a record” 和 “to record”。

## 联网词典

得到 Merriam-Webster 的使用许可后，在插件设置中切换词典来源，并用 Obsidian 的密钥存储选择 **Learner’s Dictionary API Key**。联网查询会将点选的查询文字和接口所需的 Key 发送给 Merriam-Webster。词典录音在点播时加载，词条卡片标注来源。 [官方接口](https://dictionaryapi.com/products/api-learners-dictionary) · [使用条款](https://dictionaryapi.com/info/terms-of-service)

联网查询结果保存在当前库的本机缓存中。默认最多保存 512 条，从查询完成起保留 168 小时（7 天），重启后仍可复用。两个上限都可在设置里调整，任一项填 0 即关闭缓存。查无词条的结果也会缓存。

遇到网络错误、超时或词典服务异常时，默认等待 500 毫秒自动重试 1 次。仍失败时，可在原卡片内点「重试」。遇到密钥错误或请求限额时，卡片会直接显示对应提示。

设置页的「今日词典请求次数」按本机日期统计本库实际发出的查词请求。每次发送计一次，缓存命中、离线样例和录音点播不计入。计数从 0.1.1 开始，重启后仍保留当天的数值。

## 使用

- 把布尔属性 `english-hover: true` 加到要查词的笔记或摘抄模板。正文、引用和列表可以触发，链接、代码和公式会跳过。
- 在词上停留约 300 毫秒，单词会显示悬停标记，鼠标变成手形。此时点击才会查询。悬停标记默认是柔和底色，可在「悬停样式」中切换为短下划线。较慢的查询会显示骨架动画。
- 拖选一段连续文字。松开鼠标后，在选区内移动并停留，点出现的「查词」按钮查询选中的文字。选区可包含部分单词、短语和折行。直接点击正文、复制和右键菜单由 Obsidian 处理。取消选区后恢复单词悬停。
- 查词卡片会保持打开，可以移入卡片点播或复制释义。点击卡片外、按 `Esc` 或切换笔记即可收起。
- 在「设置 → Palimserest → 查词与缓存」可调整悬停时长、选区长度上限、选区按钮隐藏延迟、卡片释义上限、单词长度上限、加载提示延迟、单次请求超时、自动重试次数和间隔、缓存词条上限和缓存有效期。
- 词典返回不同词形时，卡片会标出词条原形。音标和录音随各自的词形或词性显示。

插件由 Obsidian 直接加载仓库中的 JavaScript、样式和语言资源，无需构建。界面文案跟随 Obsidian 的界面语言，中文界面使用 `locales/zh.json`，其他语言和缺失条目回退到 `locales/en.json`。维护译文时，保留各语言文件中对应的键和 `{...}` 占位符。
