import { ref, watch } from 'vue';
import { shellMessages } from './locales/shell';
import { creationMessages } from './locales/creation';
import { imageMessages } from './locales/images';
import { errorMessages } from './locales/errors';
import { agentMessages } from './locales/agent';
export type Locale = 'zh-CN' | 'en';
const STORAGE_KEY = 'bimage-language';
function initialLocale(): Locale {
  try { return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh-CN'; } catch { return 'zh-CN'; }
}
export const locale = ref<Locale>(initialLocale());
const messages: Record<string, string> = { ...errorMessages, ...shellMessages, ...creationMessages, ...imageMessages, ...agentMessages };
export function setLocale(value: Locale) { locale.value = value; }
export function toggleLocale() { setLocale(locale.value === 'en' ? 'zh-CN' : 'en'); }
/** Application-owned UI copy only. Never run translation over user data. */
export function t(source: string, params: Record<string, string | number> = {}): string {
  const text = locale.value === 'en' && Object.hasOwn(messages, source) ? messages[source] : source;
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => params[key] === undefined ? whole : String(params[key]));
}
export function formatDate(value: string): string {
  return new Date(value).toLocaleString(locale.value === 'en' ? 'en-US' : 'zh-CN');
}
watch(locale, value => {
  if (typeof document !== 'undefined') document.documentElement.lang = value;
  try { localStorage.setItem(STORAGE_KEY, value); } catch { /* storage optional */ }
}, { immediate: true });
