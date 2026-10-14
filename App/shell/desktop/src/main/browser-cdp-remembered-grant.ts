import { BROWSER_USE_DEFAULT_DECISION, evaluateBrowserUseSiteRule, parseBrowserUsePattern,
  type BrowserUseSiteRule } from '@memmy/local-api-contracts';

type SitePolicyStore = {
  list(): BrowserUseSiteRule[];
  upsert(rule: BrowserUseSiteRule): BrowserUseSiteRule[];
};

/** A dialog grant persists only Debug / CDP for the exact origin shown to the user. */
export function rememberBrowserCdpGrant(store: SitePolicyStore, origin: string): boolean {
  const canonical = parseBrowserUsePattern(origin)?.canonical;
  if (!canonical || canonical.includes('*')) return false;
  const rules = store.list();
  // Recheck after the dialog: a concurrent settings denial must win.
  if (evaluateBrowserUseSiteRule(rules, canonical, 'fullCdp') === 'block') return false;
  const existing = rules.find(rule => parseBrowserUsePattern(rule.pattern)?.canonical === canonical);
  const rule: BrowserUseSiteRule = existing ?? { pattern: canonical,
    access: BROWSER_USE_DEFAULT_DECISION, downloads: BROWSER_USE_DEFAULT_DECISION,
    uploads: BROWSER_USE_DEFAULT_DECISION, fullCdp: BROWSER_USE_DEFAULT_DECISION };
  const saved = store.upsert({ ...rule, pattern: canonical, fullCdp: 'allow' });
  return evaluateBrowserUseSiteRule(saved, canonical, 'fullCdp') === 'allow';
}
