# NanoClaw 项目约定

- 修改宿主或agent-runner源码时读 [dev](container/skills/dev/SKILL.md)，构建与测试命令以对应package.json为准。
- 主仓是运行中的本机服务：可执行构建；不得在主仓安装、更新、重建依赖或改动node_modules。用任务工作树，保留他人改动。
- PR默认merge commit；合并和服务重启须有用户明确授权。测试通过不代表已经部署。
- GitNexus用于共享入口、公共接口、鉴权、状态机、跨模块与重构的影响分析；低风险文档、测试和独立叶子改动用差异与定向验证。
- 查询图谱的方法见 [code-graph](container/skills/code-graph/SKILL.md)。先检查索引所属仓库与版本；缺MCP时尝试CLI，均不可用则说明并人工查调用链。过期、UNKNOWN或未找到结果不能证明无影响。
- 只对当前工作树使用detect_changes，不在任务工作树重建共享索引。HIGH/CRITICAL影响先向用户说明。
