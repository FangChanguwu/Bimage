<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { CircleCheck, CircleAlert, TriangleAlert, X } from 'lucide-vue-next';
export type NoticeType = 'success' | 'error' | 'warning';
export interface Notice { message: string; type: NoticeType; action?: 'settings'; shape?: 'pill' }
const props = defineProps<{ notice: Notice | null }>();
const emit = defineEmits<{ close: []; settings: [] }>();
const layer = ref<HTMLDivElement>();
const portal = ref<HTMLElement | string>('body');
watch(() => props.notice, async notice => {
  if (!notice) return;
  layer.value?.hidePopover?.();
  portal.value = document.querySelector<HTMLDialogElement>('dialog[open]') || 'body';
  await nextTick(); layer.value?.showPopover?.();
}, {immediate: true, flush: 'post'});
onBeforeUnmount(() => layer.value?.hidePopover?.());
</script>
<template>
  <Teleport :to="portal"><div ref="layer" popover="manual" class="toast-layer">
    <Transition name="toast" appear><div v-if="notice" :key="notice.message + notice.type" class="toast" :data-type="notice.type" :data-shape="notice.shape" :role="notice.type === 'success' ? 'status' : 'alert'" :aria-live="notice.type === 'success' ? 'polite' : 'assertive'" aria-atomic="true">
      <CircleCheck v-if="notice.type === 'success'" :size="20" aria-hidden="true" /><TriangleAlert v-else-if="notice.type === 'warning'" :size="20" aria-hidden="true" /><CircleAlert v-else :size="20" aria-hidden="true" />
      <span>{{ notice.message }}</span><button v-if="notice.action === 'settings'" type="button" @click="emit('settings')">去配置供应商</button><button type="button" class="icon-button" aria-label="关闭通知" @click="emit('close')"><X :size="16" /></button>
    </div></Transition>
  </div></Teleport>
</template>
