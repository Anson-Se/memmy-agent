# 插件市场实现现状与差距

核对日期：2026-10-12。核对基线：`plugin-marketplace` 分支。产品规则以 [插件安装与权限 PRD](./plugin-permission-model.md) 为准。

本报告记录实现前的静态核对快照；后续规则与生命周期改动见 [插件规则与资格接口](./plugin-rules-api.md)。下述差距不表示这些后续改动尚未完成。

本次为本地静态代码核对，未运行应用、测试或远程服务器接口；“已有”表示存在实现，不代表端到端验收通过。未修改产品代码。

## 已有能力与可复用部分

| 范围 | 现有实现 | 依据 |
| --- | --- | --- |
| Manifest | 能声明能力、运行时、资源权限、命令、技能和 UI；支持可选 `requiredEntitlement`、`modelPolicy.requiredSource` | `App/backend/local-api-contracts/src/plugin.ts` |
| 本地安装接口 | 已有安装、列举已安装插件、启用、停用、更新、卸载和能力执行接口 | `App/backend/src/adapters/inbound/local-api/routes/plugins.ts` |
| 资格数据 | 云账号资料读取 `entitlements`（兼容 `entitlementList`、`entitlement_list`），持久化并提供 `getEntitlements()` | `App/backend/src/adapters/outbound/cloud-client/http-cloud-client.ts`、`App/backend/src/infrastructure/app-state-store/repositories/account-session-repo.ts` |
| Host 校验 | 插件服务在安装、更新、启用和新能力调用时检查 manifest 声明的 entitlement；生产服务注入账号资格判定函数 | `App/backend/src/services/plugin-service.ts`、`App/backend/src/services/index.ts` |
| 资格协调 | `plugin:*` grant 驱动安装/更新、批准权限、启用；资格被移除则 disable。启动时调用，登录和云资料刷新后通过回调调用 | `App/backend/src/services/plugin-entitlement-reconcile-service.ts`、`App/backend/src/index.ts`、`App/backend/src/services/account-service.ts` |
| 远程发布与下载 | HTTP registry 按 ID/版本解析 release，可携带账号凭证，处理 401/403；下载校验 SHA-256、包内 manifest 和解压边界 | `App/backend/src/adapters/outbound/plugin-registry/http-plugin-registry.ts`、`App/backend/src/adapters/outbound/plugin-artifact/index.ts` |
| 卸载选择 | SQLite `plugin_uninstall_preferences` 持久化主动卸载；重新安装清除记录；捆绑启动协调读取并尊重记录 | `App/backend/src/infrastructure/app-state-store/repositories/plugin-repo.ts`、`migrations/0029-plugin-uninstall-preferences.sql`、`App/backend/src/services/bundled-plugin-bootstrap-service.ts` |
| 市场操作 | 已安装状态读回 Host；安装串联权限批准与启用；失败后重新读回，提供错误状态；“试一试”写入聊天草稿 | `App/frontend/desktop/src/pages/plugin-marketplace.tsx`、`plugin-marketplace-section.tsx` |

## 仍写死或不满足 PRD 的部分

### 1. Manifest 尚未完整表达产品规则

目前只有单个 `requiredEntitlement`，没有统一声明分发方式、安装方式、未获资格时隐藏/灰显、登录要求和默认自动更新的模型。不能仅用 entitlement 代表所有规则：公开的 Office 应手动安装，而文献综述与法律要自动安装。

现有协调器把所有 `plugin:*` grant 都视为自动安装对象，没有读取插件的自动/手动安装策略。

### 2. 市场目录是前端占位数据

`official-plugin-catalog.ts` 写死三个插件及其名称、用途、登录要求、默认安装和模型标记；版本从桌面捆绑目录读取。`officialPluginCatalog()` 没有账号资格入参，直接返回法律条目，`audience: "beta"` 没有落实过滤。

Office 和法律均写为 `installable: true`，缺少真实发布状态。未发布显示“即将上线”的 UI 分支存在，但此目录没有据实际产物使用它。

本地 `GET /api/v1/plugins` 仅返回已安装插件；HTTP registry 只有按 ID 解析 release，没有目录列举接口。缺少账号过滤后的目录、`canInstall`、`canUse`、阻塞原因等契约。

### 3. 捆绑安装流程（历史核对，已收尾）

2026-10-21 已移除桌面端内置插件版本锁和构建时的 release/ZIP 复制入口，Mac、Windows 和开发启动统一使用 `prepare-plugin-migration-state.mjs`。版本由远程插件目录决定，不再随客户端固定。旧的 `MEMMY_BUNDLED_PLUGIN_SOURCE_DIR` 不再参与构建。

包内 `bundled-plugins` 目录仅保留 `bundled-plugins-state.json`，记录历史管理过的插件 ID（无版本、摘要或发布产物），供旧安装迁移使用。后端旧内置包读取和迁移兼容保留；新构建不携带可供内置 registry 解析的 release。市场演示目录的版本也只读取 Host 已安装记录。

远程 release 与下载适配器可复用，但没有在本次核对中验证实际服务器是否按账号资格发放法律包，也未验证 Office、法律正式产物。资源目录的版本声明不能证明已部署发布包可用。

### 4. 资格驱动安装没有尊重卸载记录

`reconcileEntitledPlugins()` 对未安装且有 grant 的插件直接 install，未读取 `listUserUninstalledIds()`。因此后续资格协调可能重新装回用户主动卸载的插件；目前只有捆绑协调器尊重卸载记录。

### 5. 资格刷新和失效处理不完整

启动、登录、云资料刷新有资格协调入口。市场刷新目前仅读取已安装插件和模型配置，没有刷新服务器资格；未找到专用定期/推送资格刷新机制。

`account-service.ts` 的 logout 清理本地账号，但没有直接调用 `onAccountGrantsRefreshed` 回调。需补齐退出和账号切换后的统一协调，并验证 MCP/Agent 工具发现同步。

资格失效调用 `plugins.disable()`，运行时 `deactivate()` 会取消所有 active calls（`App/backend/src/adapters/outbound/plugin-runtime/runtime-host.ts`）。这与“允许已有任务完成，阻止新任务”冲突，需把使用资格与安装/运行状态分开，或增加等待已有调用结束的停用流程。

MCP 工具目录目前按 `state === "active"` 过滤，未直接按资格过滤（`App/backend/src/adapters/inbound/local-api/routes/plugin-mcp.ts`）；invoke 有资格校验作为兜底，但不能代替正确的工具可发现性。

### 6. 自动更新只具备调用基础

已有显式 update、捆绑启动更新和资格协调时更新。尚未形成按 manifest 策略、发布版本和账号资格统一控制的自动更新流程，也没有验证更新过程中已有任务的处理。

### 7. 官方模型推荐仍残留限制语义

详情页已写推荐文案，目录仍设置 `requiresOfficialModel: true`。`plugin-marketplace-section.tsx` 会显示“已安装 · 需配置模型”，且 `primaryAction()` 在没有官方模型时返回 configure；需清理与“仅推荐”不一致的状态和操作。

后端仍支持 `modelPolicy.requiredSource: "account"`，模型服务会据此限制插件推理。它是通用可选能力，不能据此断定文献综述已强制官方模型；需核对正式发布包 manifest 和实际 Agent/插件推理路由，确保文献综述不启用该限制。

## 下一轮开发顺序

1. 定义向后兼容的插件规则与账号目录契约，复用已有 entitlement 数据和 Host 校验。
2. 将主动卸载记录接到资格协调器；补齐资格刷新、退出和账号切换入口。
3. 实现资格失效后阻止新任务、已有任务继续完成的行为，以及工具发现同步。
4. 接入服务器目录和按资格分发的文献综述发布包，替代其捆绑安装路径。
5. 清理前端硬编码资格、发布状态和官方模型限制语义；再接 Office 与法律正式包。

服务器目录、发包授权和功能调用的服务端二次校验，需要相应服务端实现与联调；本地适配器只能提供接入基础。
