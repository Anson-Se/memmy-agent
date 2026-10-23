import { Link2, MessageCircle, MoreHorizontal, Plus, RefreshCw, Search } from "lucide-react";
import { Memmy } from "../components/mascot/memmy.js";
import { deriveIntegrationState, type IntegrationConnectionState } from "../integrations/connection-state.js";
import { CATEGORY_TABS, IntegrationLogoBadge, type IntegrationCategoryTab, type IntegrationMeta } from "../integrations/integration-meta.js";
import { useTranslation } from "../i18n/use-translation.js";
import { selectConnectionForIntegration, type ToolsState } from "../state/tools-slice.js";

export interface ConnectionCatalogSectionProps {
  kind: "tools" | "channels";
  /** The parent owns filtering and ordering; this view renders the supplied results. */
  items: IntegrationMeta[];
  tools: ToolsState;
  loading?: boolean;
  error?: string | null;
  search: string;
  onSearchChange(value: string): void;
  filter: "all" | "connected";
  onFilterChange(value: "all" | "connected"): void;
  connectedCount: number;
  onOpenIntegration(integration: IntegrationMeta): void;
  onRefresh(): void;
  activeCategory?: IntegrationCategoryTab;
  onCategoryChange?(category: IntegrationCategoryTab): void;
}

/** App tools and chat channels share a catalog, while preserving connection identity. */
export function ConnectionCatalogSection(props: ConnectionCatalogSectionProps) {
  const { language } = useTranslation();
  const zh = language === "zh-CN";
  const copy = (chinese: string, english: string) => zh ? chinese : english;
  const channels = props.kind === "channels";
  const title = channels ? copy("聊天渠道", "Chat channels") : copy("应用工具", "App tools");
  const searchLabel = channels ? copy("搜索聊天渠道", "Search chat channels") : copy("搜索应用工具", "Search app tools");
  const loading = props.loading ?? props.tools.status === "loading";
  const error = props.error === undefined ? props.tools.loadError : props.error;

  return (
    <section className="memory-panel plugin-marketplace-section" aria-label={title}>
      <div className="memory-panel__header">
        <div className="memory-panel__header-main extension-catalog-heading">
          <Memmy pose={channels ? "chat" : "connect"} size={56} />
          <div className="extension-catalog-heading-copy">
            <h2 className="memory-panel__title">{title}</h2>
            <p className="memory-panel__subtitle">{channels
              ? copy("连接聊天渠道，从常用聊天应用向 Memmy 发送任务。", "Connect a chat channel to send tasks to Memmy from your messaging apps.")
              : copy("连接外部应用账号，让 Memmy 在任务中使用这些工具。", "Connect your app accounts so Memmy can use them in your tasks.")}</p>
          </div>
        </div>
        <button type="button" className="memory-refresh-button" disabled={loading} onClick={props.onRefresh}
          aria-label={copy("刷新", "Refresh")} title={copy("刷新", "Refresh")}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} aria-hidden="true" />
        </button>
      </div>

      <div className="extension-catalog-toolbar">
        <div className="memory-log-filter-group" aria-label={copy("连接状态筛选", "Filter by connection status")}>
          {(["all", "connected"] as const).map((filter) => (
            <button key={filter} type="button" aria-pressed={props.filter === filter}
              className={`memory-log-filter${props.filter === filter ? " memory-log-filter--active" : ""}`}
              onClick={() => props.onFilterChange(filter)}>
              {filter === "all" ? copy("全部", "All") : `${copy("已连接", "Connected")} (${props.connectedCount})`}
            </button>
          ))}
        </div>
        <label className="extension-catalog-search">
          <Search size={15} aria-hidden="true" />
          <input type="search" aria-label={searchLabel} placeholder={searchLabel} value={props.search}
            onChange={(event) => props.onSearchChange(event.target.value)} />
        </label>
        {!channels && props.onCategoryChange ? (
          <label className="extension-catalog-category">
            <span className="sr-only">{copy("工具类别", "Tool category")}</span>
            <select aria-label={copy("工具类别", "Tool category")} value={props.activeCategory ?? "All"}
              onChange={(event) => props.onCategoryChange?.(event.target.value as IntegrationCategoryTab)}>
              {CATEGORY_TABS.map((category) => <option key={category} value={category}>{categoryLabel(category, zh)}</option>)}
            </select>
          </label>
        ) : null}
      </div>

      {error ? <p role="alert" className="mb-4 rounded-card border border-status-error/20 bg-status-error/5 p-3 text-sm text-status-error">{error}</p> : null}
      {loading ? <p role="status" className="mb-4 text-sm text-text-ink/55">{copy("正在加载连接状态…", "Loading connection status…")}</p> : null}
      {!loading && props.items.length === 0 ? (
        <div className="memory-state-box">
          {channels ? <MessageCircle size={24} aria-hidden="true" /> : <Link2 size={24} aria-hidden="true" />}
          <p>{props.filter === "connected" && !props.search
            ? copy("暂无已连接项目。", "No connected items yet.")
            : copy("没有匹配的结果。", "No matching results.")}</p>
        </div>
      ) : null}

      <div className="plugin-marketplace-grid connection-catalog-grid">
        {props.items.map((item) => {
          const state = deriveIntegrationState(selectConnectionForIntegration(props.tools, item));
          const manage = state === "connected" || state === "pending";
          const action = manage ? copy("管理", "Manage") : state === "expired" || state === "error" ? copy("重新连接", "Reconnect") : copy("连接", "Connect");
          const kind = item.surface === "channel" ? copy("聊天渠道", "chat channel") : copy("应用工具", "app tool");
          const actionLabel = zh ? `${action}${item.name}${kind}` : `${action} ${item.name} ${kind}`;
          const statusLabel = connectionStatusLabel(state, zh);
          return (
            <article key={item.identity} className="plugin-marketplace-row" data-surface={item.surface} aria-label={`${item.name} · ${kind}`}>
              <button type="button" className="plugin-marketplace-summary" disabled={loading}
                aria-label={zh ? `查看${item.name}${kind}` : `View ${item.name} ${kind}`} onClick={() => props.onOpenIntegration(item)}>
                <IntegrationLogoBadge slug={item.slug} name={item.name} surface={item.surface} sizeClassName="plugin-marketplace-icon" />
                <span className="plugin-marketplace-text">
                  <span className="plugin-marketplace-name" title={item.name}>{item.name}</span>
                  {statusLabel ? <span role="status" className={`extension-catalog-connection-status extension-catalog-connection-status--${state}`}>{statusLabel}</span> : null}
                </span>
              </button>
              <div className="plugin-marketplace-row-actions">
                <button type="button" className="plugin-marketplace-icon-button" aria-label={actionLabel} title={actionLabel}
                  disabled={loading} onClick={() => props.onOpenIntegration(item)}>
                  {manage ? <MoreHorizontal size={18} aria-hidden="true" /> : <Plus size={18} aria-hidden="true" />}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function categoryLabel(category: IntegrationCategoryTab, zh: boolean): string {
  if (!zh) return category === "All" ? "All categories" : category;
  switch (category) {
    case "All": return "全部类别";
    case "Chat": return "沟通协作";
    case "Productivity": return "效率办公";
    case "Tools & Automation": return "工具与自动化";
    case "Social": return "社交媒体";
    case "Platform": return "平台服务";
  }
}

function connectionStatusLabel(state: IntegrationConnectionState, zh: boolean): string | null {
  switch (state) {
    case "connected": return zh ? "已连接" : "Connected";
    case "pending": return zh ? "连接中" : "Connecting";
    case "expired": return zh ? "已过期" : "Expired";
    case "error": return zh ? "连接失败" : "Connection failed";
    case "disconnected": return null;
  }
}
