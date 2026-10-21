import type { InstalledPlugin } from "@memmy/local-api-contracts";
import bundledPlugins from "../../../../shell/desktop/resources/bundled-plugins.json";
import type { MarketplacePlugin } from "./plugin-marketplace-section.js";

/**
 * Presentation policy only — a stand-in for the plugin-declared rules and the
 * server-issued eligibility that will drive this catalog. `audience` marks who a
 * plugin targets (server enforces the beta whitelist); `requiresLogin` / `requiresOfficialModel`
 * are the account requirements the marketplace reads per plugin.
 */
export const OFFICIAL_PLUGIN_POLICIES = {
  "literature-review": { audience: "public", defaultInstalled: true, requiresLogin: true, requiresOfficialModel: true },
  "office": { audience: "public" },
  "legal": { audience: "beta", requiresLogin: true }
} as const;

export function pluginRequiresOfficialModel(pluginId: string | null | undefined): boolean {
  return pluginId === "literature-review";
}

export function officialPluginCatalog(options: {
  language: string;
  installed: InstalledPlugin[];
}): MarketplacePlugin[] {
  const en = options.language === "en-US";
  const bundledVersion = (id: string) => bundledPlugins.plugins.find((plugin) => plugin.id === id)?.version;
  const installedOf = (id: string) => options.installed.find((plugin) => plugin.id === id);
  return [
    {
      id: "literature-review", category: "research",
      name: en ? "Literature Review" : "文献综述",
      description: en
        ? "Find papers, organize evidence, and draft a referenced literature review."
        : "检索论文、整理证据，生成带参考文献的综述初稿。",
      ...OFFICIAL_PLUGIN_POLICIES["literature-review"],
      version: bundledVersion("literature-review"),
      installable: true,
      installed: installedOf("literature-review")
    },
    {
      id: "office", category: "office",
      name: "Office",
      description: en
        ? "Create and edit Word, Excel, and PowerPoint files, and work with PDFs."
        : "创建和编辑 Word、Excel、PPT 文档，并处理 PDF 文件。",
      ...OFFICIAL_PLUGIN_POLICIES["office"],
      version: bundledVersion("office"),
      installable: true,
      installed: installedOf("office")
    },
    {
      id: "legal", category: "legal",
      name: en ? "Legal" : "法律",
      description: en
        ? "Organize employment research materials, verify information, and draft reports for professional review."
        : "整理劳动用工调研材料、核实信息并起草报告，供专业人员审核。",
      ...OFFICIAL_PLUGIN_POLICIES["legal"],
      version: bundledVersion("legal"),
      installable: true,
      installed: installedOf("legal")
    }
  ];
}
