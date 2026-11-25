<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { CircleCheck, CircleAlert, TriangleAlert, X } from 'lucide-vue-next';
import { t } from '../i18n';
export type NoticeType = 'success' | 'error' | 'warning';
export interface NoticeAction {
  label: string;
  run: () => void;
}
export interface Notice {
  id?: number;
  message: string;
  type: NoticeType;
  action?: 'settings';
  customAction?: NoticeAction;
  shape?: 'pill';
  sticky?: boolean;
}
const props = defineProps<{ notice?: Notice | null; notices?: Notice[] }>();
const emit = defineEmits<{
  close: [id?: number];
  settings: [id?: number];
  pause: [id: number];
  resume: [id: number];
}>();
const layer = ref<HTMLDivElement>();
const portal = ref<HTMLElement | string>('body');
const items = computed<Notice[]>(() => {
  if (props.notices) return props.notices;
  return props.notice ? [props.notice] : [];
});

function pickPortalTarget(): HTMLElement | string {
  const dialogs = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
  for (let i = dialogs.length - 1; i >= 0; i--) {
    if (dialogs[i].isConnected) return dialogs[i];
  }
  return 'body';
}

let syncVersion = 0;
async function syncLayer() {
  const currentVersion = ++syncVersion;
  const hasItems = items.value.length > 0;
  const nextPortal = hasItems ? pickPortalTarget() : 'body';
  if (portal.value !== nextPortal) {
    try { layer.value?.hidePopover?.(); } catch { /* ignore */ }
    portal.value = nextPortal;
  }
  await nextTick();
  if (currentVersion !== syncVersion) return;
  const el = layer.value;
  if (!el || !el.isConnected) return;
  if (hasItems) {
    try { el.hidePopover?.(); } catch { /* ignore */ }
    try { el.showPopover?.(); } catch { /* ignore */ }
  } else {
    try { el.hidePopover?.(); } catch { /* ignore */ }
  }
}

let observer: MutationObserver | null = null;
onMounted(() => {
  observer = new MutationObserver(() => {
    if (items.value.length > 0) void syncLayer();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['open'],
  });
});

watch(
  () => items.value.map((n) => `${n.id ?? ''}:${n.message}:${n.type}`).join('|'),
  () => { void syncLayer(); },
  { immediate: true, flush: 'post' },
);

function onFocusOut(event: FocusEvent, id?: number) {
  if (id === undefined) return;
  const host = event.currentTarget as HTMLElement | null;
  const next = event.relatedTarget as Node | null;
  if (host && next && host.contains(next)) return;
  emit('resume', id);
}

function runCustomAction(item: Notice) {
  item.customAction?.run();
  emit('close', item.id);
}

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  try { layer.value?.hidePopover?.(); } catch { /* ignore */ }
});
</script>
<template>
  <Teleport :to="portal">
    <div ref="layer" popover="manual" class="toast-layer">
      <TransitionGroup name="toast" tag="div" class="toast-stack" appear>
        <div
          v-for="item in items"
          :key="item.id ?? `${item.message}:${item.type}`"
          class="toast"
          :data-type="item.type"
          :data-shape="item.shape"
          :role="item.type === 'success' ? 'status' : 'alert'"
          :aria-live="item.type === 'success' ? 'polite' : 'assertive'"
          aria-atomic="true"
          @mouseenter="item.id !== undefined && emit('pause', item.id)"
          @mouseleave="item.id !== undefined && emit('resume', item.id)"
          @focusin="item.id !== undefined && emit('pause', item.id)"
          @focusout="onFocusOut($event, item.id)"
        >
          <CircleCheck v-if="item.type === 'success'" :size="16" aria-hidden="true" />
          <TriangleAlert v-else-if="item.type === 'warning'" :size="16" aria-hidden="true" />
          <CircleAlert v-else :size="16" aria-hidden="true" />
          <span>{{ t(item.message) }}</span>
          <button v-if="item.action === 'settings'" type="button" @click="emit('settings', item.id)">{{ t('去配置供应商') }}</button>
          <button v-else-if="item.customAction" type="button" @click="runCustomAction(item)">{{ t(item.customAction.label) }}</button>
          <button type="button" class="icon-button" :aria-label="t('关闭通知')" @click="emit('close', item.id)"><X :size="14" /></button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
