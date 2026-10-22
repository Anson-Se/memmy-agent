# Memory 队列改造：阶段 8 整体回归与 macOS 安装验证

日期：2026-10-22。工作分支 `test-memory-queue-v1.2.6`，整体 PR 目标 `upstream/v1.2.6`。按用户确认，工作文档从阶段 6 直接进入阶段 8；不恢复已取消的生产背压部分。本轮只验证 macOS arm64，不提交 PR。

## 基线与范围

阶段 8 开始前已通过 merge 同步 `upstream/v1.2.6` 的 `f19bd810`，合并提交为 `53d312b0`。保留阶段 1–6 的持久化单 worker、WRR 4/3/2/2/1、可运行 FIFO、租约 fencing、失败退避、四层并发和连续补位设计。

测试环境为 Node 22.23.3、npm 10.9.9、macOS arm64；安装包使用 Electron 自带 Node 22.20.0。项目当前桌面版本仍为 1.2.3，Memory 版本为 2.1.6；目标 Git 分支 v1.2.6 不等同于包内版本，本轮没有单独改版本号。

本轮还纳入用户授权的旧模型配置兼容补修：迁移把残留平台标记当成真实平台身份，可能误删仍在使用的自定义 Memory 连接。保留连接后，同一 Provider 的默认密钥、headers、body 又可能串入其请求，因此补齐独立 endpoint 的可选 `inheritProviderDefaults:false`。缺省/true 保持原继承规则。未选择向量模型仍使用默认本地模型，Memory loader 原规则及对应既有测试未改。

## 迁移兼容：先复现、再补修

- 错误保留方式先由实际 Memory 客户端请求暴露：只保留目录但不保留必要 raw fixed/custom 字段，会使摘要不可配置或 embedding 回退 local；只复制连接也会继承无关 Provider 的凭据及 `body.model`。正式修前记录见 `/private/tmp/memmy-stage8-endpoint-isolation-before.log`、`/private/tmp/memmy-stage8-endpoint-inheritance-before.log`。
- 独立端点使用正常 canonical Provider 和有效 assignment，不创建虚假 preset、私有 Provider 或假配置密钥；端点自有参数与 Provider 默认值分离。SDK 内原有的初始化占位值仅在内部使用，明确无鉴权时不进入 HTTP Authorization。
- 配置读取、迁移、实际模型客户端、Backend 投影、设置页保存、冲突重试、连接测试、Agent 主/备用模型及快照签名均保留独立语义。测试连接依据可信已保存端点判定，无鉴权权限不由客户端自报标记决定。
- 新增 `v1.2.6/0001-preserve-independent-memory-connections`，覆盖已执行旧迁移的安装；不重跑整个 normalize。只处理仍留有配置信息、实际独立且激活的目标连接。不改无关标签、Agent 配置和 Provider 默认值；已丢失且无备份的连接信息无法凭空恢复。
- 历史 normalize/repair 和后续修复均尊重已有 null/缺省/builtin-local 向量选择。对原标记范围保留 raw custom 但不自动激活；真正尚无目录的旧自定义连接仍可首次导入。
- 交叉审查补出了 Anthropic 无环境密钥硬拦截、OpenAI 自有 key 时环境组织/项目串入，以及历史 normalize 覆盖本地 embedding 选择的边界，均先新增失败回归再修复。

迁移全量 279 通过、1 跳过，新增迁移回归 106 项；共享契约显式测试 60 通过；Agent 全量 7,142 通过、80 跳过。最终仓库级检查和安装包结果在下文补记，不用中间包代替最终交付。

## 受控负载与真实模型证据

使用真实 MemoryDb、Repositories、WorkerRunner、路由和并发控制器，以 10,000 条导入积压加 interactive、reflection、maintenance、embedding retry 混合工作验证调度。此组 handler 是受控替身，结果不代表 10,000 条已全部完成摘要。

| 场景 | 完成窗口 | 启动计数（interactive/repair_retry/import/evolution/maintenance） | 真实请求峰值 |
| --- | --- | --- | --- |
| 串行，8 KiB | 24 | 8/6/4/4/2 | 1 |
| 本地并发，8 KiB | 36 | 8/23/2/2/1 | 1 |
| 云限制，1 KiB | 36 | 12/9/6/6/3 | 2 |
| 云限制，32 KiB | 36 | 12/9/6/6/3 | 2 |

所有 Lane 都有进展，可运行 FIFO 成立；没有尚未启动就增加 attempts/token 的任务，窗口结束无遗留许可/租约。Embedding 微批按成员条数计量，因此本地微批窗口不要求每条任务计数恰好等于 WRR 权重。云场景下一条导入在前一条慢任务完成前启动，证明连续补位。

证据在 `/private/tmp/memmy-stage8-load/`。仍有性能观察项：阻塞候选多时存在大量重复 SQLite candidate 查询，受控云窗口首次执行约 0.46–0.50 秒、36 条窗口约 8.9–11 秒；这些结果没有已定义的产品延迟阈值，不能据此宣称任意负载下零等待或吞吐已达标。

本机 LM Studio 另执行过两条短合成导入的真实摘要和向量请求，2 summary + 2 embedding 成功、两条 ready、向量 768 维，真实请求峰值 1。该次源代码证据位于 `/private/tmp/memmy-stage8-real-local/`，运行基线为 `53d312b0`；不能当作最终 DMG 或真实云 Provider 的测试。模型不支持 json_object 时，既有 text 降级成功。

## 自动检查中的非产品失败记录

1. 依赖最初缺少 Monaco，补齐本机已有的同版本 0.57.0 后检查通过，未升级依赖或改锁文件。
2. 沙箱环境不允许开启部分本地测试端口，导致 Memory HTTP 用例超时；在允许本地端口的环境重跑后 1,694 通过、1 跳过。后续新增 1 项保存/密钥轮换边界纳入最终全量。
3. 并行重建 contracts 的 dist 曾使 Agent 单文件导入失败；最终检查采用先构建后测试，避免共享产物竞态。
4. Agent Session DAG 原有一项用例曾在全量中出现 30 秒 processed=false，相关源码及用例未改，也不经过本轮 Provider 路径。整文件 16/16、原用例连续 8 次以及补修后的全量均通过；最初失败原因未确认，保留原失败和复核日志，不把原因直接归于 CPU 或环境。
5. 用系统 Node 加载 Electron ABI 的 SQLite 原生模块曾报不匹配，属于验证器运行时选错；包内验证改用该安装包自带 Electron Node。工作区与日常仓库的依赖已隔离，不修改日常安装的原生模块。

## 最终检查与安装包验收

最终 `npm run lint`、`npm run typecheck`、Agent typecheck、`npm test`、显式 contracts 测试均通过。`npm test` 含 release 30 通过/5 跳过、packaging guards 122/1、Memory 1,695/1、Migrations 279/1、Backend 1,109、Frontend 2,452、Electron 1,259/126；跳过项沿用各套件原有条件，不能记为已覆盖平台能力。Agent 独立全量 7,142/80。

最终日志：`/private/tmp/memmy-stage8-{lint,typecheck,root,agent,contracts}-accepted.log`；Agent 单独类型日志为 `/private/tmp/memmy-stage8-agent-typecheck-final-compat.log`。接口和类型构建完成后再执行测试，未与全量 Agent 测试并行刷新 contracts。

最终 DMG 验收待执行；本段将在安装、扫描及重启验证后补充。
