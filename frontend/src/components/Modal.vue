<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount, useId } from "vue";
import { X } from "lucide-vue-next";
import { t } from "../i18n";
const props = defineProps<{
  title: string;
  wide?: boolean;
  locked?: boolean;
  dirty?: boolean;
  dirtyMessage?: string;
}>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const stayBtn = ref<HTMLButtonElement>();
const heading = useId();
const closing = ref(false);
const confirmingDiscard = ref(false);
let closeTimer: ReturnType<typeof setTimeout> | undefined;
function close(force = false) {
  if (closing.value || props.locked) return;
  if (!force && props.dirty) {
    confirmingDiscard.value = true;
    void nextTick(() => stayBtn.value?.focus());
    return;
  }
  confirmingDiscard.value = false;
  closing.value = true;
  closeTimer = setTimeout(() => emit('close'), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 120);
}
function onCancel() {
  if (confirmingDiscard.value) {
    confirmingDiscard.value = false;
    return;
  }
  close(false);
}
watch(() => props.dirty, (dirty) => {
  if (!dirty) confirmingDiscard.value = false;
});
defineExpose({
  requestClose: () => close(false),
  forceClose: () => close(true),
});
let previous: HTMLElement | null = null;
onMounted(() => {
  previous = document.activeElement as HTMLElement;
  dialog.value?.showModal();
});
onBeforeUnmount(() => {
  clearTimeout(closeTimer);
  dialog.value?.close();
  previous?.focus();
});
</script>
<template>
  <Teleport to="body"
    ><dialog
      ref="dialog"
      :class="['dialog', { wide, closing }]"
      :aria-labelledby="heading"
      @cancel.prevent="onCancel"
      @click="
        (e) => {
          if (e.target === dialog) close(false);
        }
      "
    >
      <div class="dialog-shell" :inert="closing">
        <header class="dialog-head">
          <h2 :id="heading">{{ title }}</h2>
          <button
            class="icon-button"
            :aria-label="t('关闭弹窗')"
            :disabled="locked"
            @click="close(false)"
          >
            <X :size="19" />
          </button>
        </header>
        <div v-if="confirmingDiscard" class="dialog-discard-bar" role="alertdialog" aria-live="assertive">
          <span>{{ t(dirtyMessage || '当前有未保存的更改，确定放弃并关闭吗？') }}</span>
          <div class="dialog-discard-actions">
            <button ref="stayBtn" type="button" @click="confirmingDiscard = false">{{ t('继续编辑') }}</button>
            <button type="button" class="delete-confirm" @click="close(true)">{{ t('放弃更改') }}</button>
          </div>
        </div>
        <div class="dialog-body"><slot /></div>
      </div></dialog
  ></Teleport>
</template>
