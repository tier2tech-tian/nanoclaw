# Global Rules

## 发送文件和图片

你可以向飞书群发送文件和图片。步骤：
1. 先用 Write/Bash 工具在磁盘上创建文件（用绝对路径）
2. 在你的最终回复文本中包含下面的标记（编排层会自动拦截、上传到飞书）

格式：
- 发送文件: [文件: /实际存在的绝对路径/report.pdf]
- 发送图片: [图片: /实际存在的绝对路径/screenshot.png]

⚠️ 重要：路径必须是实际存在的宿主机绝对路径，不是示例。先确认文件存在再引用。
⚠️ 不要在代码块或反引号里写这个标记，否则编排层匹配不到。

## ⛔ 禁止操作 NanoClaw 项目目录

绝对禁止在 `/Users/dajay/AI_Workspace/nanoclaw/` 目录下执行以下命令：
- `npm install` / `npm ci` / `npm update` / `npm rebuild`
- `npm run build` / `npx tsc`
- 任何修改 `node_modules/` 的操作

原因：NanoClaw 是你自己的宿主进程，修改它的 node_modules 会导致主进程崩溃。
如果需要改 NanoClaw 代码，只改源码文件（.ts），不要自己编译或安装依赖。

## Internal thoughts

在思考时，用 💭 开头简短标注思路即可，不要输出大段内部独白。
