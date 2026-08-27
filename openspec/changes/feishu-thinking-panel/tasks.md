## 1. Runner 事件映射

- [x] 1.1 为 Claude SDK/print assistant thinking block 增加真实映射和单测
- [x] 1.2 为 interactive SSE thinking block/delta 增加累积映射和单测
- [x] 1.3 将 Codex 带文本 reasoning item 映射为 thinking 并防止误归工具事件

## 2. Host 安全分流

- [x] 2.1 给 Channel 增加可选 `updateThinking` 能力
- [x] 2.2 host 对 thinking 仅调用专用能力，保持普通消息和历史过滤边界

## 3. 飞书同卡展示

- [x] 3.1 先补脱敏、双预算、折叠面板纯函数红测并实现
- [x] 3.2 先补同卡创建、最新覆盖、幂等和创建竞态红测并实现
- [x] 3.3 先补终态保留与迟到拒绝红测并实现

## 4. 验证与交付

- [x] 4.1 跑 runner、host、飞书定向测试和 `npm run build`
- [x] 4.2 独立 review 方案、代码和测试并完成缺陷注入核验
- [ ] 4.3 创建 PR，待合并批准后运行飞书真链路 E2E
