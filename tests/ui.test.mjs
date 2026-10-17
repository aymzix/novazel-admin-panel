import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import cryptoNode from 'node:crypto';

const root = new URL('..', import.meta.url);
const html = fs.readFileSync(new URL('index.html', root), 'utf8');
const appSource = fs.readFileSync(new URL('app.js', root), 'utf8');
const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]);

class MockElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.hidden = false; this.disabled = false; this.value = ''; this.files = [];
    this.dataset = {}; this.attributes = {}; this.className = ''; this.textContent = '';
    this.onclick = this.onsubmit = this.onchange = this.oninput = null; this.src = '';
    this.type = ''; this.required = false; this.maxLength = 0;
    const self = this;
    this.classList = { toggle(c, on) { const set = new Set(self.className.split(/\s+/).filter(Boolean)); if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c); self.className = [...set].join(' '); return set.has(c); }, add(...cs) { cs.forEach(c => this.toggle(c, true)); }, remove(...cs) { cs.forEach(c => this.toggle(c, false)); }, contains(c) { return self.className.split(/\s+/).includes(c); } };
  }
  append(...nodes) { for (const n of nodes.flat()) { if (n == null) continue; n.parentNode = this; this.children.push(n); } return this; }
  appendChild(n) { return this.append(n); }
  replaceChildren(...nodes) { this.children = []; return this.append(...nodes); }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = String(v); if (k === 'id') this.id = String(v); }
  removeAttribute(k) { delete this.attributes[k]; if (k === 'src') this.src = ''; }
  querySelector(selector) {
    if (selector === 'input') return this.walk().find(n => n.tagName === 'INPUT') ?? null;
    if (selector === 'strong') return this.walk().find(n => n.tagName === 'STRONG') ?? null;
    if (selector === 'p') return this.walk().find(n => n.tagName === 'P') ?? null;
    if (selector.startsWith('.')) return this.walk().find(n => n.classList?.contains(selector.slice(1))) ?? null;
    return this.walk().find(n => n.tagName === selector.toUpperCase()) ?? null;
  }
  querySelectorAll(selector) { return this.walk().filter(n => selector === 'input' ? n.tagName === 'INPUT' : selector.startsWith('.') ? n.classList?.contains(selector.slice(1)) : n.tagName === selector.toUpperCase()); }
  walk() { return this.children.flatMap(c => [c, ...(c.walk ? c.walk() : [])]); }
  cloneNode(deep = false) { const n = new MockElement(this.tagName); n.className = this.className; n._text = this._text; if (deep) n.append(...this.children.map(child => child.cloneNode(true))); return n; }
  scrollIntoView() {}
  get textContent() { return (this._text ?? '') + this.children.map(c => c?.textContent ?? '').join(''); }
  set textContent(v) { this._text = String(v ?? ''); }
}

function makeEnvironment(config = {}, fetchImpl = async () => { throw new Error('unexpected fetch'); }) {
  const elements = Object.fromEntries(ids.map(id => [id, new MockElement(id === 'sign-in-form' || id === 'upload-form' ? 'form' : 'div')]));
  for (const id of ids) elements[id].id = id;
  elements['status-filter'].value = 'pending';
  const tabs = ['review', 'discover', 'audit'].map(view => { const b = new MockElement('button'); b.className = 'tab'; b.dataset.view = view; return b; });
  const addButtons = ['tag-ar', 'tag-en'].map(input => { const b = new MockElement('button'); b.className = 'add-tag'; b.dataset.input = input; return b; });
  const templateChild = new MockElement('div'); templateChild.className = 'empty-state';
  templateChild.append(new MockElement('strong'), new MockElement('p'));
  const template = new MockElement('template'); template.content = { firstElementChild: templateChild };
  const document = {
    body: new MockElement('body'),
    getElementById(id) { return id === 'empty-template' ? template : elements[id] ?? null; },
    createElement(tag) { return new MockElement(tag); },
    querySelectorAll(sel) { if (sel === '.tab') return tabs; if (sel === '.add-tag') return addButtons; return []; },
  };
  const calls = [];
  const fetch = async (...args) => { calls.push(args); return fetchImpl(...args); };
  const URLMock = { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} };
  class MockFormData { constructor() { this.entries = []; } set(k, v) { this.entries.push([k, v]); } }
  const context = {
    window: { NOVAZEL_ADMIN_CONFIG: config, confirm: () => true }, document, console, fetch, URL: URLMock,
    confirm: () => true, structuredClone, crypto: { randomUUID: () => cryptoNode.randomUUID() },
    Blob, FormData: MockFormData, Intl, Date, Error, Set, Map, JSON, encodeURIComponent,
    clearTimeout, setTimeout, URLSearchParams, TextEncoder,
  };
  vm.runInNewContext(appSource, context, { filename: 'app.js' });
  return { api: context.window.NovazelAdminTest, elements, tabs, calls, context };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const file = (name = 'synthetic.webp', type = 'image/webp') => { const blob = new Blob(['synthetic image bytes'], { type }); Object.defineProperty(blob, 'name', { value: name }); return blob; };
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, async json() { return body; } });

await test('DOM mock covers every ID declared by index.html', () => {
  const env = makeEnvironment();
  for (const id of ids) assert.ok(env.elements[id], `missing DOM id: ${id}`);
  assert.ok(env.api, 'config false must expose the test API');
});

await test('disabled/no-config login clears password and never fetches', async () => {
  const env = makeEnvironment(); const { api, elements, calls } = env;
  elements.email.value = 'admin@example.com'; elements.password.value = 'secret';
  let prevented = false; await api.login({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(elements.password.value, ''); assert.equal(calls.length, 0);
});

await test('no-config upload always prevents default and never sends a file', async () => {
  const env = makeEnvironment();
  env.elements['image-file'].files = [file()];
  let prevented = false;
  await env.elements['upload-form'].onsubmit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(env.calls.length, 0);
  assert.match(env.elements['global-message'].textContent, /لم يُرسل أي ملف/);
});

await test('demo login, upload and all demo actions remain local and prevent upload default', async () => {
  const env = makeEnvironment(); const { api, elements, calls } = env;
  api.setDemo(); await tick(); assert.equal(calls.length, 0); assert.equal(elements.workspace.hidden, false);
  elements['image-file'].files = [file()]; let prevented = false;
  await elements['upload-form'].onsubmit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(calls.length, 0);
  assert.equal(api.state.demoAudit[0].action, 'asset_proposed');
});

await test('demo import is pending, exact duplicate path is rejected, and no duplicate records appear', async () => {
  const env = makeEnvironment(); const { api, elements } = env; api.setDemo(); await tick();
  const before = api.state.demoAssets.length; elements['discover-refresh'].onclick?.();
  await api.importAsset('archive/synthetic.webp'); const after = api.state.demoAssets.length;
  assert.equal(after, before + 1); const count = api.state.demoAssets.filter(a => a.path === 'archive/synthetic.webp').length; assert.equal(count, 1);
  const imported = api.state.demoAssets.find(a => a.path === 'archive/synthetic.webp');
  assert.equal(imported.metadataStatus, 'pending'); assert.equal(imported.tags.length, 0);
  await api.importAsset('archive/synthetic.webp'); assert.equal(api.state.demoAssets.filter(a => a.path === 'archive/synthetic.webp').length, 1);
  assert.match(elements['global-message'].textContent, /duplicate_path/);
});

await test('demo tag normalization rejects duplicates; edit keeps ID and clears reviewer/time', async () => {
  const env = makeEnvironment(); const { api } = env; api.setDemo(); await tick();
  const item = api.state.demoAssets[0]; await api.proposeTag(item.path, null, '  New   Tag ');
  const tag = item.tags.find(t => t.value === '  New   Tag '); assert.ok(tag); const id = tag.id;
  await api.proposeTag(item.path, null, 'NEW TAG'); assert.equal(item.tags.filter(t => api.normalizeTag(t.value) === 'new tag').length, 1);
  tag.reviewedBy = 'old-reviewer'; tag.reviewedAt = 'old-time'; await api.proposeTag(item.path, id, 'Edited Tag');
  assert.equal(tag.id, id); assert.equal(tag.status, 'pending'); assert.equal(tag.reviewedBy, null); assert.equal(tag.reviewedAt, null);
  const audit = api.state.demoAudit.find(a => a.action === 'tag_proposed' && a.details?.new?.id === id); assert.ok(audit); assert.ok(audit.details.old); assert.equal(audit.details.new.id, id);
});

await test('demo review actions are metadata-gated and render pending/approved forms plus approval buttons', async () => {
  const env = makeEnvironment(); const { api, elements } = env; api.setDemo(); await tick();
  const pending = api.state.demoAssets.find(a => a.metadataStatus === 'pending');
  await api.reviewTag(pending.path, 'missing', 'verified'); assert.match(elements['global-message'].textContent, /tag_not_reviewable/);
  await api.reviewAsset(pending.path, 'verified'); const tagId = (await api.proposeTag(pending.path, null, 'Reviewable'), pending.tags[0].id);
  await api.loadList(); const card = elements['asset-list'].children.find(c => c.textContent.includes(pending.path));
  assert.ok(card?.querySelectorAll('form').length >= 1); assert.ok(card?.textContent.includes('إعادة اقتراح الوسم'));
  assert.ok(card?.textContent.includes('اعتماد الوسم'));
  assert.ok(card?.textContent.includes('رفض الوسم'));
  await api.reviewTag(pending.path, tagId, 'verified'); await api.loadList();
  const approved = elements['asset-list'].children.find(c => c.textContent.includes(pending.path));
  assert.ok(approved?.textContent.includes('Reviewable'));
  assert.ok(approved?.textContent.includes('معتمدة'));
});

await test('demo audit retains actor/details and paginates', async () => {
  const env = makeEnvironment(); const { api, elements } = env; api.setDemo(); await tick();
  await api.importAsset('archive/synthetic.webp'); await api.loadAudit();
  assert.ok(elements['audit-list'].children.length > 0); const row = elements['audit-list'].children[0];
  assert.match(row.textContent, /demo-admin/); assert.match(row.textContent, /synthetic/); assert.match(elements['audit-page-label'].textContent, /من/);
});

await test('demo discover renders folders, eligible files and bounded pagination', async () => {
  const env = makeEnvironment(); const { api, elements } = env; api.setDemo(); await tick(); await api.loadDiscover();
  assert.ok(elements['discover-list'].children.some(r => r.textContent.includes('archive'))); assert.equal(elements['discover-next'].disabled, true);
  const folder = elements['discover-list'].children.find(r => r.textContent.includes('archive') && r.textContent.includes('فتح المجلد'));
  assert.ok(folder); const open = folder.children.find(c => c.textContent === 'فتح المجلد'); open.onclick(); await tick();
  assert.equal(api.state.prefix, 'archive'); assert.match(elements['discover-prefix'].textContent, /archive/);
});

await test('signout clears password, token, demo data and preview state', async () => {
  const env = makeEnvironment(); const { api, elements } = env; api.setDemo(); await tick();
  elements.password.value = 'secret'; api.state.token = 'token'; api.state.previewUrl = 'blob:synthetic'; api.signOut();
  assert.equal(api.state.token, null); assert.equal(api.state.demo, false); assert.equal(api.state.demoAssets.length, 0); assert.equal(elements.password.value, ''); assert.equal(elements.workspace.hidden, true);
});

await test('live simulation accepts Auth session without user_metadata role when backend list is 200', async () => {
  let n = 0; const env = makeEnvironment({ enableLive: true, supabaseUrl: 'https://fake.invalid', publishableKey: 'a-valid-publishable-key', adminFunctionUrl: 'https://fake.invalid/admin' }, async () => {
    n++; return n === 1 ? response(200, { access_token: 'live-token', user: { email: 'admin@example.com', user_metadata: {} } }) : response(200, { items: [], count: 0 });
  });
  assert.equal(env.api, undefined); env.elements.email.value = 'admin@example.com'; env.elements.password.value = 'pw';
  await env.elements['sign-in-form'].onsubmit({ preventDefault() {} }); await tick();
  assert.equal(env.calls.length, 3); assert.equal(env.elements['admin-identity'].textContent, 'admin@example.com');
  assert.equal(env.elements.workspace.hidden, false);
  assert.equal(env.elements['sign-in-panel'].hidden, true);
  assert.equal(env.elements.password.value, '');
  assert.ok(env.calls.every(([url]) => String(url).startsWith('https://fake.invalid')));
});

await test('live backend 403 denies workspace and clears token', async () => {
  let n = 0; const env = makeEnvironment({ enableLive: true, supabaseUrl: 'https://fake.invalid', publishableKey: 'a-valid-publishable-key', adminFunctionUrl: 'https://fake.invalid/admin' }, async () => {
    n++; return n === 1 ? response(200, { access_token: 'live-token', user: { email: 'x@example.com', user_metadata: { role: 'admin' } } }) : response(403, { error: 'denied' });
  });
  env.elements.email.value = 'x@example.com'; env.elements.password.value = 'pw'; await env.elements['sign-in-form'].onsubmit({ preventDefault() {} });
  assert.equal(env.elements.workspace.hidden, true); assert.equal(env.elements['sign-out'].hidden, true); assert.match(env.elements['global-message'].textContent, /denied/);
});

await test('live upload sends multipart and displays retained-object recovery without network', async () => {
  let n = 0; const env = makeEnvironment({ enableLive: true, supabaseUrl: 'https://fake.invalid', publishableKey: 'a-valid-publishable-key', adminFunctionUrl: 'https://fake.invalid/admin' }, async () => {
    n++;
    if (n === 1) return response(200, { access_token: 't', user: { email: 'x@example.com' } });
    if (n <= 3) return response(200, { items: [], count: 0 });
    return response(400, { error: 'upload_registration_failed', recovery: { objectRetained: true, path: 'private/recovery.webp' } });
  });
  env.elements.email.value = 'x@example.com'; env.elements.password.value = 'pw';
  await env.elements['sign-in-form'].onsubmit({ preventDefault() {} });
  env.elements['image-file'].files = [file('x.webp')];
  await env.elements['upload-form'].onsubmit({ preventDefault() {} });
  assert.equal(env.calls.length, 4);
  assert.equal(env.calls[3][1].method, 'POST');
  assert.ok(env.calls[3][1].body.entries.some(([field]) => field === 'image'));
  assert.match(env.elements['global-message'].textContent, /private\/recovery\.webp/);
  assert.match(env.elements['global-message'].textContent, /لم يُحذف شيء/);
});

console.log(`ui.test.mjs: ${ids.length} DOM IDs discovered; all node:test assertions passed`);
