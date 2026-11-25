<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { Check, ChevronDown } from "lucide-vue-next";
import { t } from "../i18n";
export interface SelectOption { value: string; label: string; secondary?: string; disabled?: boolean }
const props = defineProps<{ modelValue: string; options: SelectOption[]; label: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const trigger = ref<HTMLButtonElement>(), menu = ref<HTMLDivElement>();
const portal = ref<HTMLElement | string>('body');
const id = useId(), open = ref(false), active = ref(-1), position = ref<Record<string, string>>({});
const selected = computed(() => props.options.find(o => o.value === props.modelValue));
let buffer = '', typedAt = 0;
function place() {
  const r = trigger.value?.getBoundingClientRect();
  if (!r) return;
  const below = innerHeight - r.bottom - 12, above = r.top - 12;
  const down = below >= Math.min(240, above);
  position.value = { left: `${Math.max(8, Math.min(r.left, innerWidth - r.width - 8))}px`, width: `${Math.min(r.width, innerWidth - 16)}px`, maxHeight: `${Math.max(72, Math.min(300, down ? below : above))}px`, ...(down ? { top: `${r.bottom + 6}px` } : { bottom: `${innerHeight - r.top + 6}px` }) };
}
function highlight(index: number) {
  active.value = index;
  nextTick(() => menu.value?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' }));
}
function show() {
  if (props.disabled) return;
  place(); open.value = true;
  const selectedIndex = props.options.findIndex(o => o.value === props.modelValue && !o.disabled);
  highlight(selectedIndex >= 0 ? selectedIndex : props.options.findIndex(o => !o.disabled));
  nextTick(() => { if (menu.value?.showPopover) menu.value.showPopover(); });
}
function close() { menu.value?.hidePopover?.(); open.value = false; buffer = ''; }
function choose(index: number) {
  const option = props.options[index];
  if (!option || option.disabled) return;
  emit('update:modelValue', option.value); close(); trigger.value?.focus();
}
function move(delta: number) {
  for (let i = 1; i <= props.options.length; i++) {
    const index = (active.value + delta * i + props.options.length) % props.options.length;
    if (!props.options[index]?.disabled) { highlight(index); break; }
  }
}
function keydown(e: KeyboardEvent) {
  if (props.disabled) return;
  if (e.key === 'Escape') {
    if (!open.value) return;
    e.preventDefault(); e.stopPropagation();
    close(); return;
  }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(e.key)) {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Enter' || e.key === ' ') { if (open.value) choose(active.value); else show(); return; }
    const wasOpen = open.value; if (!wasOpen) show();
    if (e.key === 'Home') highlight(props.options.findIndex(o => !o.disabled));
    else if (e.key === 'End') highlight(props.options.findLastIndex(o => !o.disabled));
    else if (wasOpen) move(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Tab') close();
  else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault(); if (!open.value) show();
    const now = Date.now();
    const repeat = now - typedAt <= 700 && buffer === e.key;
    buffer = now - typedAt > 700 || repeat ? e.key : buffer + e.key; typedAt = now;
    const query = buffer.toLocaleLowerCase();
    const candidates = props.options.map((o, index) => ({...o, index}));
    const ordered = repeat ? [...candidates.slice(active.value + 1), ...candidates.slice(0, active.value + 1)] : candidates;
    const index = ordered.find(o => !o.disabled && o.label.toLocaleLowerCase().startsWith(query))?.index ?? -1;
    if (index >= 0) highlight(index);
  }
}
function outside(e: Event) {
  if (!trigger.value?.contains(e.target as Node) && !menu.value?.contains(e.target as Node)) close();
}
function scroll(e: Event) { if (open.value && !menu.value?.contains(e.target as Node)) place(); }
watch(() => props.disabled, value => { if (value) close(); });
onMounted(() => {
  portal.value = trigger.value?.closest('dialog') || 'body';
  document.addEventListener('pointerdown', outside, true); document.addEventListener('focusin', outside);
  window.addEventListener('resize', place); window.addEventListener('scroll', scroll, true);
});
onBeforeUnmount(() => {
  close(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside);
  window.removeEventListener('resize', place); window.removeEventListener('scroll', scroll, true);
});
</script>
<template>
  <button ref="trigger" type="button" role="combobox" class="select-trigger" :data-value="modelValue" :aria-label="label" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="open ? id : undefined" :aria-activedescendant="open && active >= 0 ? `${id}-${active}` : undefined" :disabled="disabled" :title="selected?.secondary || selected?.label" @click="open ? close() : show()" @keydown="keydown">
    <span>{{ selected?.label || t('请选择') }}</span><ChevronDown :size="16" aria-hidden="true" />
  </button>
  <Teleport :to="portal">
    <div v-if="open" :id="id" ref="menu" popover="manual" role="listbox" :aria-label="label" class="select-menu" :style="position" @keydown="keydown" @pointerdown.prevent>
      <div v-for="(option, index) in options" :id="`${id}-${index}`" :key="option.value" role="option" :aria-selected="option.value === modelValue" :aria-disabled="option.disabled || undefined" :data-active="index === active" class="select-option" :title="option.secondary ? `${option.label} · ${option.secondary}` : option.label" @pointermove="!option.disabled && highlight(index)" @click="choose(index)">
        <span class="select-option-copy"><span>{{ option.label }}</span><small v-if="option.secondary">{{ option.secondary }}</small></span><Check v-if="option.value === modelValue" :size="16" aria-hidden="true" />
      </div>
    </div>
  </Teleport>
</template>
