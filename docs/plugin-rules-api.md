# 插件规则与资格接口

产品依据：`plugin-permission-model.md`。插件包内 `plugin.json` 新增可选 `rules`；没有该字段的旧插件使用公开分发、手动安装的默认规则；声明了授权要求的插件仍须通过资格校验。`requiredEntitlement` 保留在清单顶层，作为唯一的授权要求字段。

```json
{
  "rules": {
    "distribution": "account",
    "installation": "automatic",
    "requiresLogin": true,
    "unavailableVisibility": "visible",
    "autoUpdate": true,
    "recommendsOfficialModel": true
  }
}
```

这是文献综述的声明。Office 使用公开、手动安装的默认值；法律应在清单顶层声明 `requiredEntitlement: "plugin:legal-labor"`，并在 `rules` 中声明 `requiresLogin: true`、`installation: "automatic"` 和 `unavailableVisibility: "hidden"`。`distribution` 为 `public` 或 `account`，不是下载授权实现本身；服务器仍须校验包访问资格。

法律插件的声明示例：

```json
{
  "requiredEntitlement": "plugin:legal-labor",
  "rules": {
    "distribution": "account",
    "installation": "automatic",
    "requiresLogin": true,
    "unavailableVisibility": "hidden"
  }
}
```

授权要求由清单顶层字段声明；`rules` 只描述登录、安装、可见性和更新等规则。服务器判定账号是否拥有对应资格，Host 不自行授予资格。

## 目录接口

远程 registry 的 `GET /api/v1/plugins` 返回当前账号可见的 **manifest 数组**。文献综述的公开元数据须允许未登录读取，以显示登录入口；包下载仍由服务器校验。法律无白名单资格时不返回。Host 请求带当前账号 bearer 凭证。

既有 `GET /api/v1/plugins/:id?version=...` 返回 `{ manifest, artifact: { url, sha256 } }`，下载接口拒绝无资格账号。目录不得携带白名单用户清单或凭证。服务端实现见 `memmy-backend/PLUGIN_REGISTRY.md`；客户端不会伪造成功结果。

本地 Host 的 `GET /api/v1/plugins/catalog` 返回数组：

```json
[{
  "manifest": { "apiVersion": "memmy/v1", "id": "...", "rules": {} },
  "eligibility": {
    "visible": true,
    "canInstall": false,
    "canUse": false,
    "reason": "login_required"
  },
  "installed": { "id": "...", "state": "disabled" }
}]
```

示例省略 manifest/installed 必填业务字段。`installed` 仅已安装时存在；`reason` 是 `null`、`login_required` 或 `entitlement_required`。资格由 Host 依据已刷新云账号资料计算，安装、更新、启用和调用仍再次校验。已安装列表也带资格，MCP 工具目录排除不可用插件。

## 生命周期

启动、登录、云账号资料刷新与退出时进行协调；市场面板刷新先拉账号资料，然后读取目录，每 30 秒重新刷新。自动安装只针对目录内声明 `automatic` 且有资格的插件，主动卸载记录优先。安装和更新均携带目录选定的 `manifest.version`；目录缺失或失败不会退回不指定版本的自动安装。已安装同版本直接恢复，不重复下载；`autoUpdate: false` 不自动升级。

资格失效立即拒绝新能力调用并从 MCP 目录隐藏；Host 正在执行的能力调用允许返回，最后一个调用结束后停用运行时，保留安装文件。恢复资格重新启用。该保证覆盖 Host active calls；插件若在能力响应后自行启动脱离 Host 的后台任务，需要其任务协议另行保证生命周期。

官方模型是详情推荐，不构成使用门槛；文献综述不声明 `modelPolicy.requiredSource`。

## 本地接入与部署边界

文献综述源码在插件仓库 `dev`，声明已随本次修改加入，待发布版本为 `0.5.26`（避免修改 `0.5.25` 不可变发布包）。`scripts/serve-mpp.mjs` 支持上述目录；先生成正式 MPP 包，再启动开发 registry，并设置 `MEMMY_PLUGIN_REGISTRY_URL`。显式配置 registry 时不回退捆绑包。

旧的桌面捆绑分发仍作为兼容路径保留；要正式满足 PRD 的三个插件均不进 App 安装包，需要服务端目录/授权下载上线后切换分发和打包配置。本次未部署服务端、未发布插件包，亦未在真实账号桌面会话中完成联调。

## 服务端版本记录（本次补充）

后端基于 `test` 的 `codex/plugin-marketplace` 分支实现版本描述、默认目录与精确版本解析，
发布工具验证 SHA-256 和包内清单，禁止同版本覆盖；默认目录变化不影响旧版本解析。
目录允许匿名，按账号资格过滤隐藏插件，解析/下载再次检查授权。
代码与测试不代表已上传 OSS 或部署测试环境；正式包发布和真实桌面联调仍待执行。
