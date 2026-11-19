<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { ArrowRight, Moon, Sun } from "lucide-vue-next";
import { useSession } from "./composables/useSession";
import Workspace from "./components/Workspace.vue";
import ToastNotice, { type Notice } from './components/ToastNotice.vue';
import type { Site } from "./types";
const session = useSession();
const { identity, pending, ready } = session;
const key = ref(""),
  notice = ref(""),
  site = ref<Site>({ title: "Bimage", icon: "/Bimage.png" }),
  theme = ref(localStorage.getItem("bimage-theme") || "light");
const warning = ref<Notice | null>(null);
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
  [site, identity],
  () =>
    (document.title = `${site.value.title || "Bimage"} | ${identity.value ? "图像工作台" : "登录"}`),
  { immediate: true },
);
onMounted(() => {
  session
    .api<Site>("/site")
    .then(updateSite)
    .catch(() => {});
  session.restore();
});
async function login() {
  warning.value = null;
  clearTimeout(warningTimer);
  notice.value = "";
  try {
    await session.login(key.value);
    key.value = "";
  } catch (e) {
    notice.value = (e as Error).message;
  }
}
async function logout() {
  key.value = "";
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
    @csrf="session.updateCsrf"
  />
  <main v-else class="login">
    <button
      class="icon-button login-theme"
      aria-label="切换主题"
      @click="theme = theme === 'light' ? 'dark' : 'light'"
    >
      <Moon v-if="theme === 'light'" :size="20" /><Sun
        v-else
        :size="20"
      /></button
    ><img class="login-logo" :src="site.icon || '/Bimage.png'" alt="站点图标" />
    <h1>{{ site.title || "Bimage" }}</h1>
    <form class="login-form" @submit.prevent="login">
      <input
        v-model="key"
        aria-label="访问密钥"
        name="key"
        type="password"
        autocomplete="current-password"
        required
        placeholder="请输入访问密钥"
        :disabled="pending || !ready"
      /><button class="primary" :disabled="pending || !ready">
        {{ pending ? "连接中…" : "进入" }}<ArrowRight :size="18" />
      </button>
    </form>
    <p v-if="notice" class="login-error" role="alert">{{ notice }}</p>
  </main>
  <ToastNotice :notice="warning" @close="warning = null" />
</template>
