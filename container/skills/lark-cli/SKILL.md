---
name: lark-cli
description: "识别飞书操作所属业务域，并转到对应lark技能。"
codex-shared: true
---

# 飞书操作路由

先读取当前运行时对应的官方领域技能，不在这里维护第二份API教程：

- 文档正文：lark-doc；电子表格：lark-sheets；多维表格：lark-base。
- 云盘文件、导入、权限与评论：lark-drive；知识空间与节点：lark-wiki。
- 消息和群聊：lark-im；日程、任务、邮件分别为lark-calendar、lark-task、lark-mail。
- 登录、身份、缺失权限或配置问题：lark-shared；其他领域从已安装技能中选择。

Wiki链接先查节点的实际资源类型，再进入对应正文或表格技能。脚本调用参数以领域技能及CLI帮助为准。

所有lark-cli调用加LARK_CLI_NO_PROXY=1。租户共享资源在应用已有访问权限时可用--as bot；个人数据或代用户动作按授权使用--as user。身份由任务语义与权限共同决定，权限错误先读lark-shared，不盲目换身份绕过。

需要本项目快捷脚本创建、读取文档或上传产物时读 [feishu-docs](../feishu-docs/SKILL.md)；编辑文档仍先读官方lark-doc。
