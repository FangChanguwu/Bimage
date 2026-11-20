import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import JobCard from '../src/components/JobCard.vue';
import Lightbox from '../src/components/Lightbox.vue';
import RepairEditor from '../src/components/RepairEditor.vue';
import AssetImage from '../src/components/AssetImage.vue';
import ToastNotice from '../src/components/ToastNotice.vue';
import { emptyForm } from '../src/domain';
import { locale } from '../src/i18n';
import type { Job, Run } from '../src/types';

const wrappers: VueWrapper[] = [];
let controller: AbortController;
const run: Run = async fn => fn();
const job = (): Job => ({
  id: 'image-job', status: 'succeeded', created: '2026-11-19T13:05:00Z',
  startedAt: '2026-11-19T13:05:00Z', finishedAt: '2026-11-19T13:05:02Z',
  form: { ...emptyForm(), prompt: '保留我的提示词\n原样显示', model: '模型-id-unchanged' },
  tasks: [{ id: 'image-task', status: 'succeeded', asset: 'image-one', width: 640, height: 480 }],
});
function keep<T extends VueWrapper>(wrapper: T): T { wrappers.push(wrapper); return wrapper; }
beforeEach(() => {
  locale.value = 'en';
  controller = new AbortController();
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) { this.removeAttribute('open'); });
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Blob(['test image'])));
});
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  controller.abort();
  locale.value = 'zh-CN';
  document.body.innerHTML = '';
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('image UI language', () => {
  it('renders English history and deletion confirmation while preserving prompts and model IDs', async () => {
    const fixture = job();
    const remove = vi.fn().mockResolvedValue(undefined);
    const wrapper = keep(mount(JobCard, { attachTo: document.body, props: { job: fixture, api: vi.fn(), signal: controller.signal, run, remove, cancelling: false } }));
    expect(wrapper.get('.status').text()).toContain('Completed');
    expect(wrapper.get('.status').text()).toContain('2.00s');
    expect(wrapper.get('time').text()).toBe(new Date(fixture.created).toLocaleString('en-US'));
    expect(wrapper.get('.prompt-summary').attributes('title')).toBe('View full prompt');
    expect(wrapper.get('.job-meta').text()).toContain('模型-id-unchanged');
    expect(wrapper.find('[aria-label="View image"]').exists()).toBe(true);
    expect(wrapper.getComponent(AssetImage).props('alt')).toBe('Generated image 1');
    await wrapper.get('.delete-job').trigger('click');
    expect(document.querySelector('dialog h2')?.textContent).toBe('Delete job');
    expect(document.querySelector('.delete-description')?.textContent).toContain('This cannot be undone.');
    expect(document.querySelector('.delete-prompt')?.textContent).toBe(fixture.form.prompt);
    const confirm = document.querySelector<HTMLButtonElement>('.delete-confirm')!;
    expect(confirm.textContent?.trim()).toBe('Delete permanently');
    confirm.click(); await flushPromises();
    expect(remove).toHaveBeenCalledWith('image-job');
    locale.value = 'zh-CN'; await nextTick();
    expect(wrapper.get('.status').text()).toContain('已完成');
    expect(document.querySelector('dialog h2')?.textContent).toBe('删除任务');
  });

  it('renders English repair controls and validation while preserving entered instructions', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 640, height: 480, close: vi.fn() }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const fixture = job();
    fixture.tasks.push({ ...fixture.tasks[0], id: 'second-task', asset: 'image-two' });
    const wrapper = keep(mount(RepairEditor, { attachTo: document.body, props: { job: fixture, signal: controller.signal, api: vi.fn() } }));
    await flushPromises();
    expect(document.querySelector('dialog h2')?.textContent).toBe('Local repair');
    expect(document.querySelector('[role="combobox"][aria-label="Repair image"]')?.textContent).toContain('Image 1');
    expect(document.querySelector('[aria-label="Brush width"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Annotation canvas"]')).not.toBeNull();
    expect(document.querySelector('dialog')?.textContent).toContain('Brush');
    expect(document.querySelector('textarea')?.placeholder).toContain('Describe');
    const need = document.querySelector('textarea')!;
    need.value = '把红色区域改成蓝色';
    need.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    document.querySelector<HTMLButtonElement>('.primary')!.click(); await nextTick();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Add an annotation to the image first');
    locale.value = 'zh-CN'; await nextTick();
    expect(document.querySelector('dialog h2')?.textContent).toBe('局部修复');
    expect(need.value).toBe('把红色区域改成蓝色');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('请先在图内添加标注');
  });

  it('translates image loading failures and notification controls without changing unknown notification content', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network fixture'));
    const image = keep(mount(AssetImage, { props: { asset: 'missing-image', original: true, signal: controller.signal, alt: 'user supplied alt 文本' } }));
    await flushPromises();
    expect(image.attributes('alt')).toBe('Failed to load the image. Reopen it to try again');
    const toast = keep(mount(ToastNotice, { attachTo: document.body, props: { notice: { message: '当前环境不支持图片剪贴板，需要 HTTPS；请下载原图', type: 'warning', action: 'settings' } } }));
    await flushPromises();
    expect(document.querySelector('.toast')?.textContent).toContain('HTTPS');
    expect(document.querySelector('.toast')?.textContent).toContain('Configure provider');
    expect(document.querySelector('[aria-label="Close notification"]')).not.toBeNull();
    expect(document.querySelector('.toast')?.textContent).not.toMatch(/[\u3400-\u9fff]/);
    await toast.setProps({ notice: { message: '供应商自定义错误保持原样', type: 'error' } });
    expect(document.querySelector('.toast')?.textContent).toContain('供应商自定义错误保持原样');
  });

  it('localizes detail field labels and statuses while leaving stored form values intact', async () => {
    const fixture = job();
    const wrapper = keep(mount(JobCard, { attachTo: document.body, props: { job: fixture, api: vi.fn(), signal: controller.signal, run, remove: vi.fn(), cancelling: false } }));
    await wrapper.get('.prompt-summary').trigger('click');
    expect(document.querySelector('dialog h2')?.textContent).toBe('Job details');
    expect(Array.from(document.querySelectorAll('dt'), node => node.textContent)).toContain('Model');
    expect(Array.from(document.querySelectorAll('dt'), node => node.textContent)).toContain('Output format');
    expect(document.querySelector('dialog')?.textContent).toContain('Completed');
    expect(document.querySelector('.detail-prompt')?.textContent).toBe(fixture.form.prompt);
    expect(document.querySelector('dialog')?.textContent).toContain('模型-id-unchanged');
  });

  it('renders English preview actions and translates live without touching the original asset', async () => {
    const wrapper = keep(mount(Lightbox, { attachTo: document.body, props: { asset: 'preview-original', signal: controller.signal, run } }));
    await flushPromises();
    expect(document.querySelector('dialog h2')?.textContent).toBe('Image preview');
    expect(document.querySelector('[aria-label="Zoom in"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Zoom out"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Reset zoom"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Close dialog"]')).not.toBeNull();
    expect(document.querySelector('dialog')?.textContent).toContain('Download original');
    const source = wrapper.getComponent(AssetImage).attributes('src');
    expect(source).toMatch(/^blob:/);
    expect(fetch).toHaveBeenCalledWith('/api/assets/preview-original', expect.anything());
    locale.value = 'zh-CN'; await nextTick();
    expect(document.querySelector('dialog h2')?.textContent).toBe('图片预览');
    expect(document.querySelector('[aria-label="关闭弹窗"]')).not.toBeNull();
    expect(wrapper.getComponent(AssetImage).attributes('src')).toBe(source);
  });
});
