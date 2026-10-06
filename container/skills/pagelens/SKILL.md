---
name: pagelens
description: 95分 App 截图 → 子页面编号/名称、平台、参考图、三端承载代码、客户端代码入口、后端接口。用户发 95分 App 截图/翻拍图问"这是哪个页面 / 对应什么代码 / 调了哪些接口"，或给子页面编号要查代码与接口时使用。
codex-shared: true
---

# PageLens 代码定位

本地 CLI `pagelens` 直连百炼定位模型 + 随包数据，不依赖 134/159 服务。源码与 README 在 `pagelens` 仓库 `cli/`。

## 前置

```bash
pagelens doctor
```
四行 ✓ 才可用。Key 已内置在包里不用配；doctor 显示的 Key 片段**不要抄进回复**。命令不存在 → `uv tool install --python 3.11 <pagelens 仓库>/cli`。

## 用法

```bash
# 识别截图，拿完整 JSON，并把参考图拷到本群目录便于发图
pagelens scan <截图路径> --json --copy-preview <本群工作目录>/pagelens-shots

# 已知编号，不调模型直接查
pagelens info 300001_01 --json
```

## 回复怎么写

1. 先读 JSON 的 `status`：`ok` 正常；`unknown_page` 说"模型给了 X 但数据包没登记"；`unrecognized` 说"模型输出不可解析"并带 `model_output`。
2. 一句话给结论：**子页面编号 + 名称（所属页面名）+ 平台**。编号后必须跟名称，大杰看不懂裸编号。`candidates` 多于 1 个要列出来说"模型拿不准"。
3. 承载代码用 `subpage.ios_code / android_code / rn_code`；代码入口用 `code_entries` 的 仓库 + 文件 + 首行号；接口用 `interfaces` 的 `path` + 一句 `description` 摘要 + `repository`。超过 6~8 条只列头部，说明总数。
4. 发参考图：用 `preview.copied_to` 的绝对路径，按群规则写图片标记。`preview` 为 null 就说无参考图。
5. 必须交代两条边界：接口是**页面级静态可达**（不是当前子页面能直接触发的子集），`code_entries` 为空表示知识库没这个页面的代码入口；翻拍帧平台判定不稳，`platform` 为 `unknown` 时别硬猜。

## 退出码

`0` 成功；`2` 模型有输出但数据包不认 / 不可解析；`1` 参数、Key、网络错误（stderr 有中文原因，原样转述）。
