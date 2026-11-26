import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const source = read('chrome/content.js');

// Expose the private functions in an isolated VM. The production script still runs its
// normal startup on a blank document. All browser operations below use test doubles.
function loadLauncher() {
  const document = {
    documentElement: {}, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => element()
  };
  const launches = [];
  let observer;
  let frameCount = 0;
  const window = {
    location: { pathname: '/', hash: '', search: '', href: 'https://example.test/', origin: 'https://example.test',
      assign(url) { launches.push(url); } },
    requestAnimationFrame() { frameCount++; }, addEventListener() {}, setInterval() {},
    btoa: value => Buffer.from(value, 'binary').toString('base64')
  };
  const env = { document, window, URL, TextEncoder,
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} }
  };
  const closing = source.lastIndexOf('}());');
  assert.ok(closing > 0);
  const expose = 'globalThis.launcher = { collectLinks, extractIssueContext, createToolButton, ' +
    'buildDiagnosticsReport, finalizeSources, issueState, mountPanel, createLaunchButton, updateLaunchButton };';
  runInNewContext(source.slice(0, closing) + expose + source.slice(closing), env);
  return { api: env.launcher, document, window, launches, observer, frameCount: () => frameCount };
}

function element(tag = 'div', text = '', attrs = {}, children = []) {
  const events = new Map();
  const node = {
    localName: tag, textContent: text, children, dataset: {}, style: {}, parentElement: null,
    getAttribute: key => attrs[key] ?? null,
    setAttribute(key, value) { attrs[key] = value; },
    matches(selector) {
      return selector.split(',').some(part => part.trim() === tag ||
        (part.trim() === 'a[href]' && tag === 'a' && Boolean(attrs.href)));
    },
    querySelectorAll(selector) {
      const descendants = children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      if (selector === '*') return descendants;
      return descendants.filter(child => selector.split(',').some(part => child.matches(part.trim())));
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    closest() { return null; },
    contains(other) { return this === other || children.some(child => child.contains(other)); },
    appendChild(child) { children.push(child); child.parentElement = this; },
    addEventListener(type, callback) { events.set(type, callback); },
    click() { events.get('click')?.({ preventDefault() {}, stopPropagation() {} }); }
  };
  for (const child of children) child.parentElement = node;
  return node;
}

test('Chrome and Firefox ship the same launcher and Firefox retains its update identity', () => {
  assert.equal(source, read('firefox/content.js'));
  assert.equal(JSON.parse(read('firefox/manifest.json')).browser_specific_settings.gecko.id,
    'okdesk-clearbat-launcher@ruffid.local');
});

test('only the bound equipment field supplies cards, including duplicate names and icon-only links', () => {
  const { api, document } = loadLauncher();
  const direct = element('a', 'Касса', { href: '/equipments/42' });
  const duplicate = element('a', 'Касса', { href: '/equipments/42/?view=short' });
  const icon = element('a', '', { href: '/equipments/43' });
  const magnifierRow = element('li', 'Касса', {}, [icon]);
  const value = element('dd', 'Касса Касса', {}, [direct, duplicate, magnifierRow]);
  const label = element('dt', 'Оборудование');
  label.nextElementSibling = value;
  const comment = element('a', 'Другая касса', { href: '/equipments/999' });
  let labels = [label];
  document.querySelectorAll = selector => selector.startsWith('dt,') ? labels :
    (selector === 'a[href]' ? [comment] : []);
  const equipment = () => Array.from(api.extractIssueContext().fields.equipment.links, link => [link.text, link.url]);
  assert.deepEqual(equipment(), [
    ['Касса', 'https://example.test/equipments/42'], ['Касса', 'https://example.test/equipments/43']
  ]);
  label.nextElementSibling = element('dd');
  assert.deepEqual(equipment(), []);
  labels = [];
  assert.deepEqual(equipment(), []);
});

test('a launch keeps the URL out of button attributes and passes it unchanged on click', () => {
  const { api, launches } = loadLauncher();
  const url = 'clearbat:/encoded-test-value?encode=full';
  const tool = { id: 'iikoOffice', displayName: 'iikoOffice', getUrl: access => access.office };
  const button = api.createToolButton(tool, { kind: 'equipment', access: { office: url } });
  assert.deepEqual(Object.keys(button.dataset), ['tool']);
  assert.deepEqual(launches, []);
  button.click();
  assert.deepEqual(launches, [url]);
});

test('the second linked device can still use shared iiko credentials', () => {
  const { api } = loadLauncher();
  const devices = [
    { kind: 'equipment', order: 0, rawAccess: { credentials: { login: 'shared', password: 'sample' } } },
    { kind: 'equipment', order: 1, rawAccess: { credentials: { login: '' },
      iikoOfficeServer: { address: 'host:443', password: '' } } }
  ];
  const url = api.finalizeSources(devices)[1].access.iikoOffice;
  const encoded = url.match(/^clearbat:\/([^?]+)\?encode=full$/)[1];
  assert.equal(Buffer.from(encoded, 'base64').toString(), '?type=iiko?url=host:443?login=shared?password=sample');
});

test('an existing equipment-card button uses the latest credentials and stops launching when cleared', () => {
  const { api, launches } = loadLauncher();
  const button = api.createLaunchButton();
  const options = { displayName: 'RustDesk', iconFile: 'rustdesk.ico', isReady: true };
  api.updateLaunchButton(button, { ...options, clearbatUrl: 'clearbat:/old' });
  api.updateLaunchButton(button, { ...options, clearbatUrl: 'clearbat:/current' });
  button.click();
  api.updateLaunchButton(button, { ...options, isReady: false, clearbatUrl: '' });
  button.click();
  assert.deepEqual(launches, ['clearbat:/current']);
  assert.deepEqual(Object.keys(button.dataset), ['isReady']);
});

test('diagnostics contain only field tags, counts, source kinds and bounded error codes', () => {
  const { api } = loadLauncher();
  api.issueState.context = { fields: { equipment: {
    labelElement: { localName: 'dt', textContent: 'secret' }, container: { localName: 'dd', outerHTML: 'secret' },
    links: [{ text: 'secret', url: 'https://private.test/' }]
  } } };
  api.issueState.sources = ['HTTP 403', 'Превышено время ожидания', 'secret', ''].map(error =>
    ({ kind: 'equipment', name: 'secret', error, access: { iikoOffice: 'secret' } }));
  assert.deepEqual(JSON.parse(api.buildDiagnosticsReport()), {
    fields: { equipment: { labelTag: 'dt', valueTag: 'dd', cardCount: 1 } },
    sources: ['http_403', 'timeout', 'read_failed', null].map(errorCode => ({ kind: 'equipment', errorCode }))
  });
});

test('panel mutations and unchanged header text do not trigger another scan', () => {
  const { api, observer, frameCount } = loadLauncher();
  const header = { textContent: 'Клиент: Тест', title: '' };
  Object.defineProperty(header, 'textContent', { get: () => 'Клиент: Тест', set() { assert.fail('redundant write'); } });
  const panel = { isConnected: true, querySelector: () => header, contains: target => target === header };
  api.issueState.panel = panel;
  api.mountPanel(panel, { clientName: 'Тест', objectName: '' });
  const mutation = target => ({ type: 'childList', target, addedNodes: [{}], removedNodes: [] });
  observer([mutation(header)]);
  assert.equal(frameCount(), 0);
  observer([mutation({})]);
  assert.equal(frameCount(), 1);
});
