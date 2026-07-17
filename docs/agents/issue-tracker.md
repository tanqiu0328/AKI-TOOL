# Issue tracker: GitHub

本仓库的 Issue 和 PRD 使用 GitHub Issues 管理，所有操作通过 `gh` CLI 完成

## 操作约定

- 创建 Issue：`gh issue create --title "..." --body "..."`，多行正文使用 heredoc
- 读取 Issue：`gh issue view <number> --comments`，同时获取标签并按需使用 `jq` 过滤评论
- 列出 Issue：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需添加 `--label` 和 `--state`
- 添加评论：`gh issue comment <number> --body "..."`
- 添加或移除标签：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- 关闭 Issue：`gh issue close <number> --comment "..."`

仓库信息从 `git remote -v` 推断，在克隆目录中运行时 `gh` 会自动完成该操作

## Pull requests as a triage surface

**PRs as a request surface: no.** 如需将外部 PR 视作功能请求，可将此值改为 `yes`

设为 `yes` 后，PR 使用与 Issue 相同的标签和状态，并通过对应的 `gh pr` 命令操作：

- 读取 PR：`gh pr view <number> --comments`，通过 `gh pr diff <number>` 获取差异
- 列出待分类的外部 PR：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，仅保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的项目
- 评论、添加标签或关闭：使用 `gh pr comment`、`gh pr edit --add-label` / `--remove-label`、`gh pr close`

GitHub 的 Issue 和 PR 共用编号空间，因此裸编号 `#42` 可能表示任意一种对象，应先运行 `gh pr view 42`，失败后再运行 `gh issue view 42`

## 当技能要求发布到 Issue tracker

创建一个 GitHub Issue

## 当技能要求获取相关 ticket

运行 `gh issue view <number> --comments`

## Wayfinding 操作

`/wayfinder` 使用一个 map Issue 管理多个 child Issue：

- Map：带有 `wayfinder:map` 标签的单个 Issue，正文保存 Notes、Decisions-so-far 和 Fog，通过 `gh issue create --label wayfinder:map` 创建
- Child ticket：作为 GitHub sub-issue 关联到 map，使用 sub-issues API 操作；若仓库未启用 sub-issues，则将 child 添加到 map 正文的任务列表，并在 child 正文顶部添加 `Part of #<map>`；标签格式为 `wayfinder:<type>`，其中类型为 `research`、`prototype`、`grilling` 或 `task`
- Blocking：优先使用 GitHub 原生 Issue dependencies；通过 `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` 添加依赖，其中 `<blocker-db-id>` 是 blocker 的数字数据库 ID，可通过 `gh api repos/<owner>/<repo>/issues/<n> --jq .id` 获取；若不可用，则在 child 正文顶部添加 `Blocked by: #<n>, #<n>`
- Frontier query：列出 map 下仍开放的 child，排除存在开放 blocker 或已有 assignee 的项目，按 map 中的顺序选择首项
- Claim：运行 `gh issue edit <n> --add-assignee @me`
- Resolve：依次添加结论评论、关闭 child，并将上下文链接追加到 map 的 Decisions-so-far
