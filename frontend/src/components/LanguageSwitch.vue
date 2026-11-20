<script setup lang="ts">
import { Languages } from 'lucide-vue-next';
import { locale, toggleLocale } from '../i18n';
withDefaults(defineProps<{ placement?: 'login' | 'sidebar' }>(), { placement: 'sidebar' });
</script>

<template>
  <button
    type="button"
    class="language-switch"
    :class="`language-switch--${placement}`"
    :aria-label="locale === 'en' ? '简体中文' : 'English'"
    :title="locale === 'en' ? '简体中文' : 'English'"
    @click="toggleLocale"
  >
    <Languages :size="18" aria-hidden="true" />
    <span :lang="locale === 'en' ? 'zh-CN' : 'en'">{{ locale === 'en' ? '简体中文' : 'English' }}</span>
  </button>
</template>

<style scoped>
.language-switch { gap: 8px; min-height: 38px; white-space: nowrap; }
.language-switch--login { position: absolute; inset-block-start: 24px; inset-inline-end: 76px; }
.language-switch--sidebar { width: 100%; justify-content: flex-start; }
@media (max-width: 1150px) {
  .language-switch.language-switch--sidebar { flex-direction: column; justify-content: center; gap: 2px; padding: 4px 0 !important; }
  .language-switch--sidebar span { display: block; font-size: 10px; line-height: 12px; }
  .language-switch--sidebar span[lang="zh-CN"] { width: 28px; white-space: normal; font-size: 11px; overflow-wrap: anywhere; }
  .language-switch--sidebar svg { display: none; }
}
@media (max-width: 560px) {
  .language-switch--login { inset-block-start: 24px; inset-inline-end: 68px; }
  .language-switch--sidebar { width: auto; }
}
</style>
