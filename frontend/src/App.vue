<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { Moon, Sun } from "lucide-vue-next";
import { useSession } from "./composables/useSession";
import Workspace from "./components/Workspace.vue";
import AuthForm from "./components/AuthForm.vue";
import LanguageSwitch from './components/LanguageSwitch.vue';
import { t, locale } from './i18n';
import ToastNotice, { type Notice } from './components/ToastNotice.vue';
import { version } from '../package.json';
import type { Site } from "./types";
const session = useSession();
const { identity, pending, ready } = session;
const notice = ref(""),
  site = ref<Site>({ title: "Bimage", icon: "/Bimage.png" }),
  theme = ref(localStorage.getItem("bimage-theme") || "light");
const warning = ref<Notice | null>(null);
const setupRequired = ref<boolean>();
const checkingSetup = ref(false), setupError = ref("");
let warningTimer: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => clearTimeout(warningTimer));
watch(
  theme,
  (t) => {
    document.documentElement.dataset.theme = t;
    localStorage.setItem("bimage-theme", t);
  },
  { immediate: true },
);
function updateSite(s: Site) {
  site.value = s;
  const icon = document.querySelector<HTMLLinkElement>("link[rel=icon]");
  if (icon) icon.href = s.icon || "/Bimage.png";
}
watch(
  [site, identity, setupRequired, locale],
  () => {
    if (!identity.value) document.title = `${site.value.title || "Bimage"} | ${t(setupRequired.value ? "初始化管理员" : "登录")}`;
  },
  { immediate: true },
);
onMounted(() => {
  session
    .api<Site>("/site")
    .then(updateSite)
    .catch(() => {});
  session.restore();
  void checkSetup();
});
async function checkSetup() {
  if (checkingSetup.value) return;
  checkingSetup.value = true;
  setupError.value = "";
  try {
    const result = await session.api<{ required: boolean }>("/setup", undefined, "GET", AbortSignal.timeout(8000));
    if (typeof result.required !== "boolean") throw Error("Invalid setup status");
    if (setupRequired.value === true && !result.required) {
      notice.value = "初始化已完成，请使用管理员账号登录。";
    }
    setupRequired.value = result.required;
  } catch {
    setupError.value = "无法确认初始化状态，请检查网络后重试。";
  } finally {
    checkingSetup.value = false;
  }
}
async function authenticate(identifier: string, password: string) {
  if (pending.value || !ready.value || setupRequired.value === undefined) return;
  warning.value = null;
  clearTimeout(warningTimer);
  notice.value = "";
  try {
    if (setupRequired.value) {
      await session.setup(identifier, password);
      if (identity.value) setupRequired.value = false;
    } else {
      await session.login(identifier, password);
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") notice.value = (e as Error).message;
    // Another tab or administrator may have completed setup while this form was open.
    if (setupRequired.value) void checkSetup();
  }
}
async function logout() {
  notice.value = '';
  const message = await session.logout();
  if (message) {
    warning.value = {message, type: 'warning'};
    clearTimeout(warningTimer);
    warningTimer = setTimeout(() => warning.value = null, 6000);
  }
}
</script>
<template>
  <Workspace
    v-if="identity"
    :key="identity.id"
    :identity="identity"
    :site="site"
    :api="session.api"
    :signal="session.signal"
    :theme="theme"
    @theme="theme = theme === 'light' ? 'dark' : 'light'"
    @logout="logout"
    @site="updateSite"
  />
  <main v-else class="login" :class="{ 'login-setup': setupRequired }">
    <div class="appearance-controls login-controls">
      <LanguageSwitch />
      <button type="button" class="icon-button login-theme" :aria-label="t('切换主题')" :title="t('切换浅色 / 暗色')" @click="theme = theme === 'light' ? 'dark' : 'light'">
        <Moon v-if="theme === 'light'" :size="18" aria-hidden="true" /><Sun v-else :size="18" aria-hidden="true" />
      </button>
    </div>
    <img class="login-logo" :src="site.icon || '/Bimage.png'" :alt="t('站点图标')" />
    <div class="login-brand">
      <h1>{{ site.title || "Bimage" }}</h1>
      <small class="login-version">v{{ version }}</small>
    </div>
    <AuthForm
      v-if="ready && setupRequired !== undefined"
      :key="String(setupRequired)"
      :setup="setupRequired"
      :pending="pending || checkingSetup"
      :error="notice"
      @submit="authenticate"
      @edit="notice = ''"
    />
    <div v-else-if="setupError" class="login-status">
      <p role="alert">{{ t(setupError) }}</p>
      <button type="button" @click="checkSetup">{{ t('重试') }}</button>
    </div>
    <p v-else class="muted" role="status">{{ t('正在连接…') }}</p>
  </main>
  <ToastNotice :notice="warning" @close="warning = null" />
</template>
