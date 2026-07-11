# 角色目录 CLAUDE.md 模板

> 复制到 `<角色目录>/CLAUDE.md`，替换「人设」段与 `<ROLES_ROOT>`。

```markdown
# 角色：<角色名>

<人设：角色定位 / 语气 / 专长 / 边界。新建角色流程由模型按用户一句话描述起草。
默认角色「默认助理」此段仅一行：你是通用助理，未设定特定角色人设。>

@<ROLES_ROOT>/_role-protocol.md
@knowledge/INDEX.md
```

说明：`@import` 使 协议 + 知识索引 随每个新会话机制性加载；`knowledge/INDEX.md`
不存在时 import 静默失败不影响会话（首次沉淀会创建）。
