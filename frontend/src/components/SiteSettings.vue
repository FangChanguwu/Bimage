<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { t } from '../i18n';
import { Upload, RotateCcw } from "lucide-vue-next";
import { fileData } from "../domain";
import type { Site, Api, Run } from "../types";
const props = defineProps<{ site: Site; api: Api; run: Run }>();
const emit = defineEmits<{ saved: [site: Site]; 'dirty-change': [dirty: boolean] }>();
const title = ref(props.site.title),
  icon = ref(props.site.icon || ""),
  baseline = ref({ title: props.site.title, icon: props.site.icon || "" }),
  input = ref<HTMLInputElement>(),
  busy = ref(false),
  readingIcon = ref(false);

const dirty = computed(
  () => title.value !== baseline.value.title || icon.value !== baseline.value.icon,
);
watch(dirty, (val) => emit('dirty-change', val), { immediate: true });
watch(
  () => props.site,
  (next) => {
    const nextBase = { title: next.title, icon: next.icon || "" };
    if (!dirty.value) {
      title.value = nextBase.title;
      icon.value = nextBase.icon;
    }
    baseline.value = nextBase;
  },
  { deep: true },
);

async function select(e: Event) {
  const el = e.target as HTMLInputElement;
  const file = el.files?.[0];
  if (!file || busy.value || readingIcon.value) return;
  readingIcon.value = true;
  try {
    await props.run(async () => {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
        throw Error("图标仅支持 PNG、JPEG、WebP");
      if (file.size > 300000) throw Error("图标最大300KB");
      icon.value = await fileData(file);
    });
  } finally {
    readingIcon.value = false;
    el.value = "";
  }
}
async function save() {
  if (busy.value || readingIcon.value) return;
  busy.value = true;
  const submittedTitle = title.value;
  const submittedIcon = icon.value;
  try {
    await props.run(async () => {
      await props.api(
        "/admin/site",
        { title: submittedTitle, icon: submittedIcon },
        "PUT",
      );
      const site = await props.api<Site>("/site");
      baseline.value = { title: site.title, icon: site.icon || "" };
      title.value = site.title;
      icon.value = site.icon || "";
      emit("saved", site);
    }, "站点设置已保存");
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="panel settings-section">
    <h2>{{ t('站点外观') }}</h2>
    <p class="muted">{{ t('用于登录页、侧栏和浏览器标签。随时可以换回默认图标。') }}</p>
    <form :aria-busy="busy || readingIcon" @submit.prevent="save">
      <fieldset class="site-fieldset" :disabled="busy || readingIcon">
        <label
          >{{ t('站点标题') }}<input
            v-model="title"
            :aria-label="t('站点标题')"
            required
            maxlength="80"
        /></label>
        <div class="field-group">
          <span id="site-icon-label" class="field-label">{{ t('站点图标') }}</span>
          <div class="site-icon-row" aria-labelledby="site-icon-label">
            <img
              class="site-icon-preview"
              :src="icon || '/Bimage.png'"
              :alt="t('站点图标预览')"
              width="80"
              height="80"
            />
            <div class="icon-upload-controls">
              <input
                ref="input"
                class="visually-hidden"
                type="file"
                :aria-label="t('站点图标')"
                accept="image/png,image/jpeg,image/webp"
                tabindex="-1"
                @change="select"
              /><button class="upload-icon" type="button" :disabled="busy || readingIcon" @click="input?.click()">
                <Upload :size="16" />{{ t(readingIcon ? '读取图标中…' : '上传图标') }}
              </button>
              <p class="muted">{{ t('PNG、JPEG 或 WebP · 最大 300 KB') }}</p>
              <button
                v-if="icon"
                class="text-button"
                type="button"
                :disabled="busy || readingIcon"
                @click="icon = ''"
              >
                <RotateCcw :size="14" />{{ t('恢复默认图标') }}
              </button>
            </div>
          </div>
        </div>
        <footer class="site-save form-footer">
          <span v-if="dirty" class="muted" role="status">{{ t('有未保存的更改') }}</span>
          <button class="primary" type="submit" :disabled="busy || readingIcon">
            {{ t(busy ? "保存中…" : "保存站点设置") }}
          </button>
        </footer>
      </fieldset>
    </form>
  </section>
</template>
<style scoped>
.site-fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
</style>
