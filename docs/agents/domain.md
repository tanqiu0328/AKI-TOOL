# 领域文档

工程技能探索代码库时，应按本文件约定读取领域文档

## 探索前读取

- 仓库根目录的 `CONTEXT.md`
- 如果根目录存在 `CONTEXT-MAP.md`，则按其中的映射读取与当前主题有关的 `CONTEXT.md`
- `docs/adr/` 中与当前工作区域相关的 ADR
- 对于 multi-context 仓库，还需检查 `src/<context>/docs/adr/`

如果这些文件不存在，应直接继续，不提示缺失，也不提前建议创建；`/domain-modeling` 技能会在领域术语或决策实际形成后按需创建

## 文件布局

本仓库采用 single-context 布局：

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

multi-context 仓库通过根目录的 `CONTEXT-MAP.md` 标识：

```text
/
├── CONTEXT-MAP.md
├── docs/adr/
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 使用词汇表中的术语

当输出内容涉及领域概念时，包括 Issue 标题、重构建议、假设和测试名称，应使用 `CONTEXT.md` 中定义的术语，避免使用词汇表明确排除的同义词

如果所需概念尚未出现在词汇表中，应重新确认它是否属于项目语言；若确实存在领域缺口，则记录并交由 `/domain-modeling` 处理

## 标明 ADR 冲突

如果输出内容与现有 ADR 冲突，应明确指出冲突，不得静默覆盖既有决策
