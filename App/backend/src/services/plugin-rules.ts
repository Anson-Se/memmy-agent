/** Evaluates plugin policy against current server-issued account facts. */
import { PluginRulesSchema, type PluginManifest, type PluginEligibility } from "@memmy/local-api-contracts";

export function pluginRules(manifest: Pick<PluginManifest, "rules" | "requiredEntitlement">) {
  return PluginRulesSchema.parse(manifest.rules ?? {});
}

export function pluginEligibility(manifest: Pick<PluginManifest, "rules" | "requiredEntitlement">,
  authenticated: boolean, hasEntitlement: (grant: string) => boolean): PluginEligibility {
  const rules = pluginRules(manifest);
  const entitlement = manifest.requiredEntitlement;
  const reason = (rules.requiresLogin || rules.distribution === "account") && !authenticated
    ? "login_required" : entitlement && !hasEntitlement(entitlement) ? "entitlement_required" : null;
  return { visible: !reason || rules.unavailableVisibility === "visible", canInstall: !reason, canUse: !reason, reason };
}
