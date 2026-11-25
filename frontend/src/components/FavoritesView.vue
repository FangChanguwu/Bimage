<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  Star,
  Download,
  Copy,
  Check,
  ImagePlus,
  RotateCcw,
  Maximize2,
  ArrowUpRight,
} from "lucide-vue-next";
import AssetImage from "./AssetImage.vue";
import Modal from "./Modal.vue";
import Lightbox from "./Lightbox.vue";
import ReferenceImages from "./ReferenceImages.vue";
import { assetCache, download, copyImage, extensionForMime } from "../composables/assetCache";
import type { FavoriteItem, GenerationForm, Run } from "../types";
import { t, formatDate } from "../i18n";

const detailLabels: Record<string, string> = {
  model: "模型",
  count: "张数",
  size: "尺寸",
  autoSize: "自动尺寸",
  resolution: "分辨率",
  ratio: "比例",
  quality: "质量",
  output_format: "输出格式",
  aspect_ratio: "宽高比",
};

const props = defineProps<{
  favorites: FavoriteItem[];
  loading: boolean;
  error?: string;
  signal: AbortSignal;
  run: Run;
  unfavorite: (asset: string) => Promise<boolean>;
}>();

const emit = defineEmits<{
  useAsReference: [asset: string];
  restore: [form: GenerationForm];
  goStudio: [];
  retry: [];
}>();

const selectedId = ref<string | null>(null);
const previewOpen = ref(false);
const copiedPrompt = ref(false);
const detailImageState = ref<"loading" | "ready" | "error">("loading");
const pendingUnfavoriteAsset = ref<string | null>(null);
const unfavoriting = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;
const selected = computed(() =>
  selectedId.value ? props.favorites.find((item) => item.id === selectedId.value) ?? null : null,
);
const detailThumb = computed(() =>
  selected.value ? assetCache(props.signal).peek(selected.value.asset, "thumbnail") : undefined,
);
const galleryItems = computed(() =>
  props.favorites.map((item) => ({ asset: item.asset, mime: item.mime })),
);

const selectedIndex = computed(() =>
  selected.value ? props.favorites.findIndex((item) => item.id === selected.value!.id) : 0,
);

watch(
  () => selected.value?.asset ?? null,
  (asset) => {
    detailImageState.value = "loading";
    if (!asset) {
      previewOpen.value = false;
      copiedPrompt.value = false;
    }
  },
);

function openDetail(item: FavoriteItem) {
  selectedId.value = item.id;
}

async function copyPrompt(text: string) {
  const ok = await props.run(async () => {
    if (!navigator.clipboard?.writeText) {
      throw Error("当前环境不支持剪贴板写入，请手动复制提示词");
    }
    await navigator.clipboard.writeText(text);
    return true;
  });
  if (!ok) return;
  copiedPrompt.value = true;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copiedPrompt.value = false;
  }, 1800);
}

function handleUseAsReference(asset: string) {
  previewOpen.value = false;
  selectedId.value = null;
  emit("useAsReference", asset);
}

function handleRestore(form: GenerationForm) {
  selectedId.value = null;
  emit("restore", form);
}

function requestUnfavorite(asset: string) {
  if (unfavoriting.value) return;
  pendingUnfavoriteAsset.value = asset;
}

async function confirmUnfavorite() {
  const asset = pendingUnfavoriteAsset.value;
  if (!asset || unfavoriting.value) return;
  unfavoriting.value = true;
  try {
    const ok = await props.unfavorite(asset);
    if (!ok) return;
    pendingUnfavoriteAsset.value = null;
    if (selected.value?.asset === asset) {
      selectedId.value = null;
    }
  } finally {
    unfavoriting.value = false;
  }
}
</script>

<template>
  <section class="favorites-view" :aria-label="t('收藏夹')">
    <div v-if="loading && !favorites.length" class="favorites-grid favorites-loading" :aria-label="t('加载中…')">
      <div v-for="n in 8" :key="n" class="favorite-skeleton" />
    </div>

    <div v-else-if="error && !favorites.length" class="empty-history favorites-empty" role="alert">
      <Star :size="38" :stroke-width="1.3" aria-hidden="true" />
      <h3>{{ t("收藏夹加载失败") }}</h3>
      <p>{{ t(error) }}</p>
      <button type="button" class="primary" @click="emit('retry')">
        {{ t("重试") }}
      </button>
    </div>

    <div v-else-if="!favorites.length" class="empty-history favorites-empty">
      <Star :size="38" :stroke-width="1.3" aria-hidden="true" />
      <h3>{{ t("暂无收藏图片") }}</h3>
      <p>{{ t("在工作台点击图片上的星标，即可把满意的作品收藏到这里。") }}</p>
      <button type="button" @click="emit('goStudio')">
        {{ t("前往图像工作台") }}<ArrowUpRight :size="15" />
      </button>
    </div>
    <div v-else class="favorites-grid">
      <button
        v-for="item in favorites"
        :key="item.id"
        type="button"
        class="favorite-tile"
        :aria-label="t('查看收藏图片详情')"
        @click="openDetail(item)"
      >
        <AssetImage
          :asset="item.asset"
          :signal="signal"
          :alt="item.form.prompt.slice(0, 80) || t('收藏图片')"
        />
      </button>
    </div>

    <Modal v-if="selected" :title="t('任务详情')" wide @close="selectedId = null">
      <div class="favorite-detail-layout">
        <div class="favorite-detail-media">
          <button
            type="button"
            class="favorite-detail-image"
            :class="{ 'has-placeholder': Boolean(detailThumb) && detailImageState !== 'error' }"
            :style="{
              '--preview-ratio':
                selected.width && selected.height && selected.width > 0 && selected.height > 0
                  ? selected.width / selected.height
                  : undefined,
            }"
            :aria-label="t('查看大图')"
            @click="previewOpen = true"
          >
            <img
              v-if="detailThumb && detailImageState !== 'error'"
              :src="detailThumb"
              alt=""
              aria-hidden="true"
              class="favorite-detail-placeholder"
              :class="{ 'is-replaced': detailImageState === 'ready' }"
            />
            <AssetImage
              :asset="selected.asset"
              :signal="signal"
              original
              :alt="selected.form.prompt.slice(0, 80) || t('收藏图片')"
              @state="detailImageState = $event"
            />
            <span
              v-if="detailImageState !== 'error'"
              class="favorite-zoom-badge"
              aria-hidden="true"
            >
              <Maximize2 :size="14" />
            </span>
          </button>

          <div class="favorite-detail-actions">
            <button
              type="button"
              @click="
                run(() =>
                  download(
                    '/api/assets/' + selected!.asset,
                    selected!.mime ? selected!.asset + '.' + extensionForMime(selected!.mime) : selected!.asset,
                    signal,
                  ),
                )
              "
            >
              <Download :size="15" />{{ t("下载原图") }}
            </button>
            <button
              type="button"
              @click="run(() => copyImage(selected!.asset, signal), t('复制成功'))"
            >
              <Copy :size="15" />{{ t("复制图片") }}
            </button>
            <button
              type="button"
              class="primary"
              @click="handleUseAsReference(selected.asset)"
            >
              <ImagePlus :size="15" />{{ t("作为参考图") }}
            </button>
            <button
              type="button"
              @click="handleRestore(selected.form)"
            >
              <RotateCcw :size="15" />{{ t("恢复参数") }}
            </button>
            <button
              type="button"
              class="favorite-remove-btn"
              :disabled="unfavoriting"
              @click="requestUnfavorite(selected.asset)"
            >
              <Star :size="15" class="star-filled" />{{ t("取消收藏") }}
            </button>
          </div>
        </div>

        <div class="favorite-detail-meta">
          <div class="favorite-section-head">
            <h3>{{ t("提示词") }}</h3>
            <button
              type="button"
              class="icon-button"
              :aria-label="t('复制提示词')"
              :title="t('复制提示词')"
              @click="copyPrompt(selected.form.prompt)"
            >
              <Check v-if="copiedPrompt" :size="14" />
              <Copy v-else :size="14" />
            </button>
          </div>
          <p class="detail-prompt">{{ selected.form.prompt }}</p>

          <h3>{{ t("生成参数") }}</h3>
          <dl class="job-details">
            <dt>{{ t("实际规格") }}</dt>
            <dd>
              {{
                selected.width && selected.height
                  ? `${selected.width} × ${selected.height}`
                  : t("规格未知")
              }}
            </dd>
            <dt>{{ t("生成时间") }}</dt>
            <dd>{{ formatDate(selected.jobCreated) }}</dd>
            <template v-for="(value, key) in selected.form" :key="key">
              <template
                v-if="
                  !['prompt', 'references', 'mask', 'providerId', 'manualSize', 'source', 'agentSessionId'].includes(
                    key,
                  ) && value !== undefined && value !== ''
                "
              >
                <dt>{{ t(detailLabels[key] || key) }}</dt>
                <dd>{{ value }}</dd>
              </template>
            </template>
          </dl>

          <h3>{{ t("参考图") }}</h3>
          <ReferenceImages
            v-if="selected.form.references?.length"
            :references="selected.form.references"
            :signal="signal"
            :run="run"
            readonly
          />
          <p v-else class="muted favorite-no-refs">{{ t("本次出图未使用参考图") }}</p>

          <template v-if="selected.form.mask">
            <h3>{{ t("像素蒙版") }}</h3>
            <div class="detail-mask-preview mask-checker">
              <AssetImage :asset="selected.form.mask" :signal="signal" :alt="t('像素蒙版')" />
            </div>
          </template>
        </div>
      </div>
    </Modal>

    <Lightbox
      v-if="previewOpen && selected"
      :asset="selected.asset"
      :mime="selected.mime"
      :items="galleryItems"
      :initial-index="selectedIndex"
      :signal="signal"
      :run="run"
      can-favorite
      can-use-as-reference
      :is-favorite="() => true"
      @toggle-favorite="requestUnfavorite"
      @use-as-reference="handleUseAsReference"
      @close="previewOpen = false"
    />

    <Modal
      v-if="pendingUnfavoriteAsset"
      :title="t('取消收藏')"
      :locked="unfavoriting"
      @close="pendingUnfavoriteAsset = null"
    >
      <p>{{ t('确定取消收藏该图片？如果原任务已删除且无其他草稿引用，该图片将被永久删除且无法恢复。') }}</p>
      <footer class="form-footer">
        <button type="button" autofocus :disabled="unfavoriting" @click="pendingUnfavoriteAsset = null">{{ t('取消') }}</button>
        <button type="button" class="delete-confirm" :disabled="unfavoriting" @click="confirmUnfavorite">
          {{ t(unfavoriting ? '处理中…' : '确认取消收藏') }}
        </button>
      </footer>
    </Modal>
  </section>
</template>
