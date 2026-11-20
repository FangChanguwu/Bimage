<script setup lang="ts">
import { ref } from "vue";
import { X, Copy } from "lucide-vue-next";
import AssetImage from "./AssetImage.vue";
import Lightbox from "./Lightbox.vue";
import { copyImage } from "../composables/assetCache";
import { t } from "../i18n";
import type { Run } from "../types";
defineProps<{ references: string[]; signal: AbortSignal; run: Run; disabled?: boolean }>();
const emit = defineEmits<{ remove: [id: string] }>();
const preview = ref("");
</script>
<template>
  <div v-if="references.length" class="references">
    <div v-for="(id, i) in references" :key="id" class="reference-image">
      <button
        type="button"
        class="reference-open"
        :aria-label="t('查看参考图')"
        :disabled="disabled"
        @click="preview = id"
      >
        <AssetImage
          :asset="id"
          :signal="signal"
          :alt="t('参考图 {index}', { index: i + 1 })"
        /></button
      ><button
        type="button"
        class="reference-copy icon-button"
        :aria-label="t('复制参考图')"
        :disabled="disabled"
        @click="run(() => copyImage(id, signal), t('复制成功'))"
      >
        <Copy :size="14" /></button
      ><button
        type="button"
        class="reference-remove icon-button"
        :aria-label="t('移除参考图')"
        :disabled="disabled"
        @click="emit('remove', id)"
      >
        <X :size="13" />
      </button>
    </div>
  </div>
  <Lightbox
    v-if="preview"
    :asset="preview"
    :signal="signal"
    :run="run"
    @close="preview = ''"
  />
</template>
