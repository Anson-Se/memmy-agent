import { useState } from "react";
import type { InstalledPlugin } from "@memmy/local-api-contracts";
import { useTranslation } from "../i18n/use-translation.js";
import { officialPluginCatalog } from "./official-plugin-catalog.js";
import { PluginMarketplaceSection, type MarketplacePlugin } from "./plugin-marketplace-section.js";

/** Preview-only account states, standing in for the sign-in + beta eligibility the server will supply. */
type PreviewAccount = "signed-out" | "member" | "beta";

/** Development-only, isolated interaction preview. Never calls the real plugin client. */
export default function PluginMarketplacePreview() {
  const { language } = useTranslation();
  const en = language === "en-US";
  const literatureName = en ? "Literature Review" : "文献综述";
  const legalName = en ? "Legal" : "法律";
  // Auto-installed plugins for a given eligibility, preserving any manually installed ones (e.g. Office).
  // Mirrors "eligibility met -> auto-installed": literature on sign-in, legal on beta access.
  function autoInstalledFor(next: PreviewAccount, manual: InstalledPlugin[] = []): InstalledPlugin[] {
    const list = [previewInstallation("literature-review", literatureName)];
    if (next === "beta") list.push(previewInstallation("legal", legalName));
    return [...list, ...manual.filter((item) => item.id !== "literature-review" && item.id !== "legal")];
  }
  const [officialModelReady, setOfficialModelReady] = useState(true);
  const [account, setAccount] = useState<PreviewAccount>("beta");
  const [installed, setInstalled] = useState<InstalledPlugin[]>(() => autoInstalledFor("beta"));
  const [notice, setNotice] = useState<string | null>(null);

  const signedIn = account !== "signed-out";
  const hasBeta = account === "beta";
  // Server-applied visibility: beta-only plugins (legal) are hidden unless the account is whitelisted.
  const plugins = officialPluginCatalog({ language, installed })
    .filter((plugin) => plugin.category !== "legal" || hasBeta);

  const accountOptions: { id: PreviewAccount; label: string }[] = [
    { id: "signed-out", label: en ? "Signed out" : "未登录" },
    { id: "member", label: en ? "Signed in · no beta" : "登录·无内测资格" },
    { id: "beta", label: en ? "Signed in · beta" : "登录·有内测资格" }
  ];

  // Switching account is a preview "eligibility refresh": auto-install what now qualifies, keep manual installs.
  function selectAccount(next: PreviewAccount) {
    setAccount(next);
    setNotice(null);
    setInstalled((items) => autoInstalledFor(next, items));
  }

  function install(plugin: MarketplacePlugin) {
    setInstalled((items) => [...items.filter((item) => item.id !== plugin.id), previewInstallation(plugin.id, plugin.name)]);
    setNotice(en ? `Preview: ${plugin.name} installed.` : `演示：已安装${plugin.name}。`);
  }

  return <>
    <aside className="plugin-marketplace-preview">
      <details>
        <summary>{en ? "Interaction preview · Demo data" : "交互预览 · 演示数据"}</summary>
        <div className="plugin-marketplace-preview-controls">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <strong>{en ? "Interaction preview" : "交互预览"}</strong>
          <p className="mt-1 opacity-70">{en
            ? "Simulates the planned release. Installs and removals here do not change your real plugins or account."
            : "预览插件发布后的交互。这里的安装、卸载和账号条件均为演示，不影响真实插件或账号。"}</p>
        </div>
        <button type="button" className="plugin-marketplace-preview-reset rounded-md px-3 py-1.5" onClick={() => {
          setAccount("beta"); setInstalled(autoInstalledFor("beta"));
          setOfficialModelReady(true); setNotice(null);
        }}>{en ? "Reset preview" : "重置预览"}</button>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="opacity-70">{en ? "Account state" : "账号状态"}</span>
        <div className="inline-flex flex-wrap gap-1.5" role="group" aria-label={en ? "Account state" : "账号状态"}>
          {accountOptions.map((option) => (
            <button key={option.id} type="button" aria-pressed={account === option.id}
              onClick={() => selectAccount(option.id)}
              className={`rounded-md border px-3 py-1.5 ${account === option.id
                ? "border-action-sky-hover bg-action-sky-hover/10 text-action-sky-hover"
                : "border-border-stone/40 text-text-ink/70 hover:bg-text-ink/5"}`}>
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-5">
        <label className="flex items-center gap-2"><input type="checkbox" checked={officialModelReady} onChange={(event) => setOfficialModelReady(event.target.checked)} />
          {en ? "Official model available" : "已配置官方模型"}</label>
      </div>
        </div>
      </details>
    </aside>
    {notice && <p role="status" className="mb-3 text-xs text-text-ink/60">{notice}</p>}
    <PluginMarketplaceSection plugins={plugins} officialModelReady={officialModelReady} signedIn={signedIn}
      onRefresh={() => setNotice(en ? "Preview state refreshed." : "已刷新演示状态。")}
      onInstall={install} onEnable={install}
      onUninstall={(plugin) => {
        setInstalled((items) => items.filter((item) => item.id !== plugin.id));
        setNotice(en ? `Preview: ${plugin.name} uninstalled.` : `演示：已卸载${plugin.name}。`);
      }}
      onAddToChat={(plugin) => setNotice(en
        ? `Preview: ${plugin.name} would be added to the current chat.`
        : `演示：将把${plugin.name}加入当前对话。`)}
      onConfigureModel={() => setNotice(en
        ? "This opens Model settings in the app. Check Official model available above to preview the ready state."
        : "正式界面会打开模型设置。勾选上方“已配置官方模型”，可查看配置完成后的状态。")}
      onSignIn={() => { selectAccount("member"); setNotice(en ? "Preview: signed in." : "演示：已登录。"); }}
    />
  </>;
}

function previewInstallation(id: string, name: string): InstalledPlugin {
  return {
    id, version: "预览", state: "active", approvedPermissions: [], config: {}, lastError: null,
    createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z",
    manifest: {
      apiVersion: "memmy/v1", id, name, version: "预览", runtime: { adapter: "command" },
      permissions: [], capabilities: [{ id: "preview", name: "Preview", description: "Preview only",
        inputSchema: {}, outputSchema: {}, execution: "request" }]
    }
  };
}
