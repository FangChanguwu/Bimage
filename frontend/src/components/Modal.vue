<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, useId } from "vue";
import { X } from "lucide-vue-next";
const props = defineProps<{ title: string; wide?: boolean; locked?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const heading = useId();
const closing = ref(false);
let closeTimer: ReturnType<typeof setTimeout> | undefined;
function close() {
  if (closing.value || props.locked) return;
  closing.value = true;
  closeTimer = setTimeout(() => emit('close'), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 120);
}
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
      @cancel.prevent="close"
      @click="
        (e) => {
          if (e.target === dialog) close();
        }
      "
    >
      <div class="dialog-shell" :inert="closing">
        <header class="dialog-head">
          <h2 :id="heading">{{ title }}</h2>
          <button
            class="icon-button"
            aria-label="关闭弹窗"
            :disabled="locked"
            @click="close"
          >
            <X :size="19" />
          </button>
        </header>
        <div class="dialog-body"><slot /></div>
      </div></dialog
  ></Teleport>
</template>
