# Draft Release 后同步 main

Draft Release 的全部安装包和元数据上传成功后，发版工作流会校验 Release、
source SHA 和资源清单，再上传同步请求 artifact。创建 Draft 即可触发，
无需 Publish。上传失败沿用原有清理；后续同步请求失败不会删除已完整生成的 Draft。

云端 CodingAgent 的现有 GitHub webhook 接收 workflow_run.completed 通知。
通知仅负责唤醒：Scheduler 会重新读取 GitHub 的具体 run attempt、原始 artifact
及其摘要、Release、main 历史和配置，确认后为每个维护分支建立同一个同步任务。
Actions 不执行模型修复，也不需要新增一套模型凭据。

## 维护分支和 PR

维护分支列在 `.github/main-sync.json` 的 targets 中。目前包含
`v1.2.5`、`v1.2.6`、`1.2.7`；新增或停止维护时通过代码评审修改此清单。
不会将所有历史 v 分支都自动纳入。

每个目标使用 `sync/main-to-<target>` 工作分支，创建或复用对应 Draft PR。
CodingAgent 普通合并两边历史，解决冲突，保留远端人工提交，再推送同步工作分支。
不会直接写 main 或目标分支，不会强推、自动合并 PR 或发布 Release。

验证失败后继续原 CodingAgent 任务、分支和 PR，不会重新开一个编码任务。
目标分支或 PR head 变化会使旧结果失效，重新合并并验证。只有当前 head/base
的 Linux 全套公开测试、类型检查、lint、构建、关键 smoke 以及原生 Windows
验证全部通过，并满足其余 GitHub 检查，才交付待审。
CI 中的 `Main Sync / Full` 状态不代表 Project Harness 审批或维护者批准。

默认最多 6 轮修复、连续 2 轮无进展或总计 180 分钟后停下，保留代码和 PR，
供维护者接手。这些上限可在同一配置文件中调整。关闭 PR 会停止管理。

## 部署与启用

先将 Memmy 工作流变更合入 main，并部署配套的 cloud-coding-agent Scheduler、
code-runner 和数据库迁移。云端仓库的 `docs/main-sync.md` 给出完整配置。
需要在现有签名 GitHub repository webhook 上订阅 **Workflow runs**，
并在现有 Memmy 仓库配置中启用 `main_sync.enabled`。功能默认关闭。

复用现有 CodingAgent 的模型配置、机器人 push/fork 注册和仓库白名单。
GitHub token 需具备 contents push、pull-request write、Actions read/write、
checks read 和 commit-status write 权限。不要将凭据放入请求 artifact 或仓库。
本次代码变更本身不修改线上配置、webhook 或部署。

## 失败恢复

若完整 Draft 已生成但同步通知失败，可在 main 上运行手动恢复工作流：

```sh
gh workflow run main-sync.yml --repo MemTensor/memmy-agent --ref main \
  -f release_id=<GitHub-Release-ID> -f source_sha=<40-hex-main-commit>
```

恢复工作流重新核对实际 Release 和 source，不接受任意分支名代替 SHA。
同一 repository/release/source/target 的重试会复用业务请求，不重复创建编码任务。
手动恢复也支持已发布的正式 Release；仍需 tag 精确指向指定 source。
排查时分别查看请求工作流、云端原任务及 `main-sync-validation.yml` 的具体 run，
不要把 workflow queued、模型自报完成或旧提交的绿色状态当成最终结果。
