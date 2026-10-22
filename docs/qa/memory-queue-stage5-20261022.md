# Memory 队列改造：阶段 5 真实 WRR 与可运行 FIFO

日期：2026-10-22。工作分支 `test-memory-queue-v1.2.6`，整体 PR 目标 `upstream/v1.2.6`。承接阶段 4 提交 `e426aed0`。用户确认的五个 Lane 权重为 **interactive / repair_retry / import / evolution / maintenance = 4 / 3 / 2 / 2 / 1**。

## 复现与范围

阶段 1 的旧算法诊断已证明：主任务占满领取名额时，Embedding retry 只能获得零个剩余名额；严格优先级和同优先级 cohort 会让其他任务长期等待；同档内按记忆创建时间倒序会使旧任务反复被新记录插队。

本阶段先用阶段 4 实现运行新增的 13 项实际 runner 调度用例，结果 **9 项失败、4 项通过**。失败覆盖跨 Lane 机会、主任务与 retry 共同领取、FIFO 和连续小 limit 调用等，日志 `/private/tmp/memmy-stage5-fairness-before.log`。这些用例使用真实 SQLite 和 WorkerRunner，业务处理器使用受控本地替身，不访问用户数据库或真实模型。

本阶段将影子算法切换为实际任务选择规则，同时保留旧算法回退。继续沿用阶段 2 的租约保护、退避与阶段 4 的统一执行入口，不实施阶段 6 的四层资源许可和连续补位，不恢复已取消的生产背压方案。

## 实现与行为

### 1. 按 Lane 分配机会，Lane 内可运行 FIFO

- 默认启用 WRR。所有 Lane 持续有可运行任务时，每个完整 12 次领取周期按 4/3/2/2/1 分配机会；空 Lane 直接跳过，不浪费名额。权重衡量领取次数，不是运行秒数或模型成本。
- 同一 Lane 中按稳定的 `enqueueSeq` 从小到大选择，与记忆创建时间无关。暂时不可运行的退避、配置、依赖或业务范围外任务不会挡住后面的可运行任务，恢复后保留原入队顺序。
- WRR 不再使用旧的“同优先级独占本轮”cohort 限制。Onboarding 首次报告保留 interactive 高权重定位，同时遵守 interactive 内 FIFO，不抢占正在运行的任务。
- 主任务与 Embedding retry 来自原有两张持久化表，但进入同一次选择，共用总领取预算；retry 不再只使用主任务的剩余名额。直接调用公开 retry 排空接口时，也使用相同的 FIFO 选择与统一执行入口。
- 领取与执行之间不再按 Embedding role 重新排序：主 Embedding 和 retry 都保留选中顺序，仅将连续同 role 的条目组成批次，仍保留相邻条目的批处理能力。FIFO 约束选择与启动顺序，不要求并发任务按同一顺序完成。

### 2. 公平性跨请求、重启持续生效

生产选择器与影子选择器共用纯算法实现。实际 WRR 游标保存在数据库 KV `worker.scheduler.wrr_cursor.v1`，连同权重签名保存；连续 `limit=1` 调用或服务重启不会反复从 interactive 起点开始。权重改变时重新开始对应的新轮次。

候选投影刷新、选择、按 ID 领取和游标更新处于同一事务。每次领取重新验证可运行条件，并生成租约 token；领取失败不消耗轮转机会，异常回滚同时撤销本次领取和游标推进。

生产路径完整刷新当前符合条件的待分类记录，避免影子采样的 500 条刷新上限使旧任务或某个 Lane 永久不可见。终态、未来执行时间和当前不符合筛选条件的记录不纳入本次刷新。未知任务显式进入受控清理路径并标记 dead letter，不调用未知业务处理器，也不持续触发空转。

### 3. 保留租约与预算安全

WRR 选择顺序可能包含“主任务、retry、主任务”。所有已领取任务从领取后立即开始续租，等待前面任务时也受保护。测试将前面的任务保持 310 秒，超过 retry 原始 5 分钟租期，验证续租有效且其他 worker 无法重新领取。

如果执行期间预算暂停，尚未启动的 retry 使用最新续租状态安全释放回 pending；不增加失败次数，不重置 FIFO 顺序和原重试时间。恢复后可继续处理。

`limit` 仍是一次执行请求的总工作预算，WRR 中包含主任务和 retry。返回结构继续分别统计 `leased`（主任务）和 `embeddingRetries.leased`，两者之和不超过该请求预算。内部每次事务最多领取 200 条；大请求分段处理。**200 是领取分段上限，不是并发上限。**

## 配置与回退

无需配置时使用 WRR 与已确认权重。进程启动环境变量：

```sh
MEMMY_WORKER_SCHEDULER_ALGORITHM=wrr
MEMMY_WORKER_LANE_WEIGHTS='{"interactive":4,"repair_retry":3,"import":2,"evolution":2,"maintenance":1}'
```

需要回退时，将 `MEMMY_WORKER_SCHEDULER_ALGORITHM` 改为 `legacy` 并重启对应服务。旧严格优先级、cohort、记忆时间倒序及剩余 retry 名额规则恢复；阶段 2 的租约保护和阶段 4 的统一入口保留。回退本身也意味着旧算法的饥饿风险重新存在。

非法算法、非法 JSON、缺少 Lane、未知 Lane、零值或不合法整数权重会明确报错，不静默换用另一组配置。依赖注入配置按字段优先于环境配置。

影子观测开关 `MEMMY_WORKER_SCHEDULER_SHADOW=0` 仅关闭对比采样，不关闭实际 WRR。影子选择使用独立游标和有限采样，不能把它当成实际游标的逐条回放。实际任务日志增加 `queueLane`、`enqueueSeq`，排空日志标注 `algorithm`，WRR 日志同时记录权重和两类任务计数。

## 验证覆盖

新增实际 runner 调度测试 **26 项通过**，主要覆盖：

- 一万条导入积压下，interactive、repair_retry、evolution、maintenance 仍获得机会；持续有任务时连续 12 次 `limit=1` 符合权重。
- 主表与 retry 表共同选择、跨表 FIFO、记忆创建时间不插队、空 Lane 借用、旧 cohort 解除。
- 退避、配置、依赖、目标筛选跳过不可运行任务，Onboarding 高权重，临时失败不吞掉其他 Lane 的机会。
- 数据库关闭重开后游标延续；第二次领取异常时第一条租约和游标一起回滚；自定义权重实际生效。
- 超过旧投影采样边界的脏记录仍按完整 FIFO 可见；未知任务不会阻断有效任务或造成持续唤醒。
- 等待中的 retry 续租、续租后预算暂停释放、恢复处理；错误配置拒绝启动；显式 legacy 回退。
- 主 Embedding 的 query/document 顺序真实保留，相邻同 role 继续成批；legacy 维持原 role 顺序。

另外增加按 ID 原子领取、重复领取失败、过期恢复、token 不匹配、释放后顺序保留、完整投影和元数据形状容错等存储测试。

原业务测试中依赖“新记忆优先”和“同优先级独占一轮”的断言改为验证新规则，保留摘要、向量、模型提示词和演化结果约束。历史基线复现明确指定 legacy，不将旧缺陷误写为当前默认行为。两项旧夹具同步修正：Agent 导入公平性使用真实 import 入口；L3/Skill 提示词测试先等待其前置 L2 更新完成再手动晋升，避免后续合法更新改变测试前提。

## 检查结果与证据

- Memory 全量：**1523 项通过，1 项跳过**；`npm run memory:lint` 通过。
- Backend 全量：**1073 项通过**；Backend TypeScript 检查通过。
- 发布流程保护：**30 项通过，5 项跳过**。
- 打包保护：**122 项通过，1 项跳过**。
- `git diff --check`：通过。
- 分工实现后独立检查了实际选择、存储领取和公平性用例；发现的 Embedding 执行时 role 重排已修复并补充回归。

最终日志：`/private/tmp/memmy-stage5-memory-tests-final.log`、`/private/tmp/memmy-stage5-memory-lint-final.log`、`/private/tmp/memmy-stage5-backend-tests.log`、`/private/tmp/memmy-stage5-backend-typecheck.log`、`/private/tmp/memmy-stage5-release-guards.log`、`/private/tmp/memmy-stage5-packaging-guards.log`。

额外 SQLite 微基准使用 5 万条已分类终态记录加 1 万条待分类可运行记录：首次刷新 1 万条约 **324ms**，之后重复候选查询约 **4.9–5.8ms**。日志 `/private/tmp/memmy-stage5-storage-bench.log`。这只是本机小记录存储基准，不能替代长对话、真实模型吞吐量或桌面 UI 压测，也不能推断所有数据规模的耗时。

## 阶段边界

WRR 保证持续可运行 Lane 获得领取机会，但前面的慢请求、既有执行批次屏障和 Provider 延迟仍可能拉长等待；没有承诺固定时间内完成，也没有抢占已运行任务。当前仍会预先领取一段任务并续租，不应声称已完成“拿齐全部资源许可后才领取”。四层许可、去除提前领取和任务完成后立即补位属于阶段 6。

本阶段未变更数据库 schema 版本，未升级依赖或包版本，未使用用户数据和真实模型。本阶段未生成 DMG、未进行安装验收、未推送、未提交 PR；按整体计划在后续阶段统一 Mac 打包验收。保存本地提交后等待用户确认，再进入阶段 6。
