import { resolveChoice } from "../domain";
import type { Provider, Settings } from "../types";

/** Resolve each text workflow without changing image defaults or the saved draft. */
export function resolveTextDefaults(providers: Provider[], settings: Settings): Settings {
  const text = resolveChoice(providers, "text", settings.textProvider, settings.textModel);
  // Presence matters: an explicitly cleared/stale quick choice must not inherit
  // the optimization choice. Only pre-split settings use legacy inheritance.
  const legacy = !Object.hasOwn(settings, "quickProvider") && !Object.hasOwn(settings, "quickModel");
  const quick = resolveChoice(providers, "text",
    legacy ? settings.textProvider : settings.quickProvider,
    legacy ? settings.textModel : settings.quickModel,
  );
  return { ...settings, textProvider: text.providerId, textModel: text.model,
    quickProvider: quick.providerId, quickModel: quick.model };
}
