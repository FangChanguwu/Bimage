<script setup lang="ts">
import { Languages } from 'lucide-vue-next';
import { locale, toggleLocale } from '../i18n';
</script>

<template>
  <button
    type="button"
    class="icon-button language-switch"
    :aria-label="locale === 'en' ? '简体中文' : 'English'"
    :title="locale === 'en' ? '简体中文' : 'English'"
    @click="toggleLocale"
  >
    <Languages :size="18" aria-hidden="true" />
  </button>
</template>
