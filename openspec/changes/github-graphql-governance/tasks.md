## 1. TDD 防线

- [x] 1.1 为后台 Project 读取补最小 GraphQL、终页/异常游标、分页、遥测和低水位熔断红测
- [x] 1.2 为三段工作流补统一治理引用与危险命令禁用红测
- [x] 1.3 为 Claude SDK/Codex 同源同步补回归测试

## 2. 核心实现

- [x] 2.1 把自动派工 loader 改为最小字段分页 GraphQL
- [x] 2.2 实现 100 点保底线、resetAt 本地熔断和配额遥测
- [x] 2.3 新增 github-project-governance Skill，覆盖低成本读写与状态回读
- [x] 2.4 改 kickoff/implement/wrapup 复用治理 Skill 并移除 gh project 旁路

## 3. 验证与交付

- [x] 3.1 运行定向测试、全量测试、lint、typecheck 与 build
- [x] 3.2 执行双轨代码/测试审查并修复所有阻塞项
- [ ] 3.3 用真实 Project #9 与后台实际项目验证完整读取和低个位数 cost，并验证两运行时同步内容一致
- [ ] 3.4 提交 PR、关联 Project 草稿项并推进评审态
