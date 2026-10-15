# 浏览器执行层整体修复与验收交接（2026-10-15）

本轮接续 `30caf7a16` 的快照挂起修复，目标是让连续网页任务可用。初次现场证据见 [快照挂起交接](browser-snapshot-stall-20261015.md)。本文件记录后续整体修复；最终验证结果以本文件为准。

## 已确认的根因和改法

| 根因 | 影响 | 本轮处理 |
| --- | --- | --- |
| Chrome 扩展用父 target 查询已附加子 target 的信息，真实 `chrome.debugger` 返回 `Not allowed` | 跨域 iframe 的初始化命令全部被前置校验拒绝，Playwright 等不到页面上下文 | 外部插件和内置浏览器统一通过已经登记的 child session 查询其自身 `Target.getTargetInfo({})`；仍核对 session、target ID、类型、URL、修订和授权 |
| task 的元素引用和诊断数据放在短暂的 CDP 连接里 | 预览失败、空闲断连、跳转回收后，刚读取的引用或动作日志丢失 | 观察结果和有界诊断归 task/tab 所有；连接可回收，真实文档换代仍使旧引用失效 |
| 子 frame 更新清除全部远端对象，或者新一轮根树覆盖未包含在其中的 OOPIF | 子页面刷新破坏主页面句柄，连续两步操作无法继续 | 对象按 session/context/frame 管理，只失效相关子树；保留经认证且仍存活的跨进程子页面映射 |
| frame 结构、导航、上下文事件到达顺序不一致；被禁止 frame 仍进入 Playwright 可见树 | 等待尚未建立的世界，或等待策略本来就禁止的内容 | 先发布可信结构，再发布导航和上下文；物理树与允许发布的树分别维护；未知 frame 有界等待，截图和无明确目标的输入保持拒绝 |
| 仅靠连接是否存在判断缓存有效 | 空闲时子页面同 URL 刷新后仍复用旧上下文 | 两个桥接层维护 `frameEpoch`，所有 frame 结构及导航变化都推进代数；旧插件缺该字段时每轮重连，沿用已有自动更新机制 |
| 停止 task 只清理当前连接，队列还可能继续 | 已停止任务排队的操作仍有机会派发 | task 状态同步撤销；运行中操作终止，排队操作校验原 owner；旧结果不能重新写入已结束 task |
| 连接回收清理的等待期间 task 已结束，或者最后一次标签页查询期间 child 已导航/解绑 | 已经校验过的旧 owner 或子页面身份在实际发送前失效 | 清理完成后先复查 task owner 再建连接；最后一次异步检查之后、发送之前再核 child 对象和修订 |
| 权限切换没有进入缓存有效性判断 | 已允许的子页面仍不可见，或沿用之前允许的视图 | `frameVersion` 纳入当前允许的 frame 集合，下轮操作按新策略重建；隐藏的上下文只保留可信身份元数据，所有执行仍校验当前策略和父链 |

上述问题已用真实隔离 Chromium 或真实扩展逐项复现失败，再验证修复。没有添加税务网站特判、控件名单、模型提示规则或输入失败后的自动重放。

### 必须保持的执行约束

- 一个执行连接只暴露选定标签页；页面弹出新标签页后仍由路由器决定归属，任务之间不串标签页。
- target/session 必须来自当前已登记的父子关系；等待 native API 之后重新检查身份和修订，迟到回复不能授权已替换的 session。
- frame 的物理存在、已确认 URL、允许的父链、Playwright 可见状态分别管理。未知 frame 不等同于允许；同一模型覆盖结构事件、执行上下文、远端对象及无明确目标输入。
- 有副作用的操作不自动重试。已经派发但未完整确认的动作返回不确定状态，要求重新观察。
- task 结束后旧动作、队列和观察结果一并撤销；清理沿用原 lease ID，不能结束新任务的 lease。
- 每轮操作有截止时间；额外展示预览独立限时；这些只是退出保障，正常执行仍依靠正确的协议事件和对象生命周期。
- 当前任务诊断缓冲有界，输出时重新执行当前站点策略；没有新增空闲网页内容采集。

## 真实生产插件的完整流程

`browser-executor-journey.test.ts` 启动私有 Chromium profile、随机本地桥接端口、本地合成网站，装载生产 MV3 插件。只将插件发现端口改为测试端口；没有 mock Chrome API、执行命令、事件、授权检查或文档代数。

实际调用路径为：

`BrowserSessionManager → ExternalBrowserSessionRouter → ExternalBrowserBridge → 生产 MV3 worker → chrome.debugger → Chromium 页面`

单次连续任务验证：

1. 读快照并使用返回引用填写表单。
2. 动态加入跨域子页面，读取并填写其中控件。
3. 触发原生 JavaScript alert 并继续操作。
4. 打开新标签页，由第二任务填写，确认主任务输入未被修改。
5. 取消找不到控件的操作，同标签页立即恢复快照。
6. 经过真实文件访问及上传策略校验，上传测试工作区文件。
7. 勾选并提交本地合成表单，读取跳转后的回执和该动作的控制台日志。
8. 实时禁止网站后拒绝继续读取；结束任务不关闭用户标签页。

测试不使用用户浏览器 profile，不访问税务网站，不提交真实业务信息。

另外的真实 CDP 合约用例覆盖同 URL 子页面刷新、稳定 OOPIF 缓存、主页面操作期间无关 frame 刷新、动态允许/禁止/未知 frame、frame 删除、跨 session 句柄拒绝、停止后的队列撤销。桥接层单元用例补充子 target ID/类型/URL/修订改变、detach、未登记 session 零 native 调用等负例。

额外的两个边界也完成修复前失败、修复后通过：回收旧连接的等待空窗中关闭 task / 全部 task，旧 work 不再新建 lease 或发送输入；最后一次 `tabs.get` 等待期间 child 同 URL 导航或解绑，身份查询之后不再向旧 child 派发页面命令。权限用例覆盖无导航时 same-process / OOPIF 的 `block → allow → block` 连续切换。

## 验证环境和运行方式

- macOS 主机，仓库锁定的 Playwright 依赖；本轮没有升级执行依赖。
- 真实扩展用例需要完整的 Chromium / Chrome for Testing。普通品牌 Chrome/Edge 不支持以命令行加载扩展的测试方式，参见 [Playwright 官方扩展测试说明](https://playwright.dev/docs/chrome-extensions)。
- 浏览器运行时可以通过 `PLAYWRIGHT_BROWSERS_PATH` 配置，或通过 `MEMMY_BROWSER_TEST_EXECUTABLE` 指向测试 Chromium；代码没有固化本机临时路径。没有可用运行时时真实 Chromium 用例会明确 skip，不能将 skip 算作执行验证。
- Chrome 的 child session 行为参见 [chrome.debugger 官方说明](https://developer.chrome.com/docs/extensions/reference/api/debugger)。本轮 native 拒绝及正确路由均由实际 worker 调用确认。

最终联合验证：

- Agent 12 个相关测试文件 **155/155 通过**，包括实际执行的隔离 Chromium / 生产 MV3 完整流程；没有 skip。
- 桌面 8 个相关测试文件 **195/195 通过**，包括两个桥接、子页面身份、History 接入、统一授权、CDP 事件和旧授权兼容。
- Agent 和桌面两套 TypeScript `--noEmit` 均通过；`git diff --check` 通过。
- 独立只读审查提出的连接回收停止竞态、外部插件最终异步查询竞态均已用修复前失败 / 修复后通过的测试闭合。
- 本地合成页面的一次联合执行记录：冷快照约 86ms，复用连接点击及观察约 119ms。这仅说明测试环境中执行开销，不代表真实网站或模型整次任务时延。

Agent 联合命令（在 `App/memmy-agent`，先配置测试 Chromium 运行时）：

```sh
./node_modules/.bin/vitest run \
  tests/core/agent-runtime/tools/external-browser-playwright.test.ts \
  tests/core/agent-runtime/tools/external-browser-playwright-relay-contract.test.ts \
  tests/core/agent-runtime/tools/browser-executor-journey.test.ts \
  tests/core/agent-runtime/tools/external-browser-tools.test.ts \
  tests/core/agent-runtime/tools/external-browser-session-router.test.ts \
  tests/core/agent-runtime/tools/external-browser-bridge.test.ts \
  tests/core/agent-runtime/tools/embedded-browser-playwright.test.ts \
  tests/core/agent-runtime/tools/browser-external-routing.test.ts \
  tests/core/agent-runtime/tools/browser-embedded-routing.test.ts \
  tests/core/agent-runtime/tools/browser-global-frame-policy.test.ts \
  tests/core/agent-runtime/tools/external-browser-history-integration.test.ts \
  tests/core/agent-runtime/tools/external-browser-upgrade-compatibility.test.ts
```

桌面联合命令（在 `App/shell/desktop`）：

```sh
../../../node_modules/.bin/vitest run \
  tests/external-browser-extension-packaging.test.ts \
  tests/embedded-browser-driver.test.ts \
  tests/browser-history-extension.test.ts \
  tests/browser-global-approval.integration.test.ts \
  tests/browser-auth-request.test.ts \
  tests/browser-embedded-cdp-access.test.ts \
  tests/browser-cdp-event-buffer.test.ts \
  tests/browser-cdp-remembered-grant.test.ts
```

## 范围、兼容和交付

- 外部 Chrome/Edge 插件及内置浏览器两条桥接都修复；它们共用 Agent 执行器。插件沿用本分支尚未交付的 `1.0.7` 和现有自动更新流程。
- 原有统一权限、网站策略、History 接入、升级兼容一起回归；没有新增 GUI、提示、数据迁移、权限开关或安装流程。
- 源码基底 `b0d83635c`，首轮修复 `30caf7a16`。打包任务应从本分支最终提交整合两轮修复，并核对自身发布分支已有修复；不要只取某一个桥接文件。
- 本任务只本地提交，不推送、不打包。VM 中当前 rc.4 不会因为源码提交自动获得修复。
- 本轮真实运行验证发生在 macOS 的隔离 Chromium；桌面桥接和 Windows 共用源码通过自动检查。尚未验收 Windows 安装包、Edge 安装态、真实站点及系统文件对话框，不能将源码测试表述为这些项目已通过。

### 新包用户回归重点

- Mac/Windows 的外部浏览器与内置浏览器连续完成原任务，包括多次观察、输入、勾选、子页面和跳转；真实开票任务继续遵守用户的“不提交”。
- 老用户覆盖升级后插件自动恢复；不装插件时原有 History 仍可用，安装后增强记录继续遵守暂停及排除应用/网站设置。
- 同时运行两个网页任务不串页；停止等待中的任务后没有迟到输入，同标签页可接新任务。
- 实时修改网站和全局权限后，后续读取和输入遵守新设置；History 的排除设置按原本的记录权限处理。
- 若真实站点仍失败，保留时间、任务记录和 `[browser-executor]` 阶段日志，确认是工具执行、路由、模型决策还是站点本身状态。通用合约测试是已验证范围，不是对任意网站成功率的保证。
