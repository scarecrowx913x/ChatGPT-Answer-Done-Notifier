const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SCRIPT_PATH = path.join(__dirname, '..', 'ChatGPT-Answer-Done-Notifier.user.js');
const RAW_SOURCE = fs.readFileSync(SCRIPT_PATH, 'utf8');
const SOURCE = RAW_SOURCE
  .replace('var QUIET_MS = 2500;', 'var QUIET_MS = 2;')
  .replace('var COOLDOWN_MS = 2000;', 'var COOLDOWN_MS = 0;')
  .replace('var MAX_COMPLETED_TURNS = 100;', 'var MAX_COMPLETED_TURNS = 3;')
  .replace('setTimeout(setupObserver, 2000);', 'setTimeout(setupObserver, 0);')
  .replace('setTimeout(setupObserver, 5000);', 'setTimeout(setupObserver, 0);')
  .replace('doneTimer = setTimeout(checkCompletion, QUIET_MS + 150);', 'doneTimer = setTimeout(checkCompletion, QUIET_MS + 1);')
  .replace('doneTimer = setTimeout(checkCompletion, 500);', 'doneTimer = setTimeout(checkCompletion, 1);');

function delay(ms = 8) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createHarness({ permission = 'default', hidden = true, sound = false, notification = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><head><link rel="icon" href="/favicon.ico"></head><body><main></main></body></html>', {
    url: 'https://chatgpt.com/c/test',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const store = new Map([
    ['gptNotifier_soundEnabled', sound],
    ['gptNotifier_notificationEnabled', notification]
  ]);
  const menuCommands = new Map();
  const alerts = [];
  let requestPermissionCount = 0;
  let notificationCount = 0;
  let beepCount = 0;

  Object.defineProperty(window.document, 'hidden', {
    configurable: true,
    get: () => hidden
  });

  window.GM_getValue = (key, fallback) => store.has(key) ? store.get(key) : fallback;
  window.GM_setValue = (key, value) => store.set(key, value);
  window.GM_registerMenuCommand = (name, callback) => menuCommands.set(name, callback);
  window.alert = (message) => alerts.push(message);

  class FakeNotification {
    static permission = permission;
    constructor() {
      notificationCount += 1;
    }
    static requestPermission() {
      requestPermissionCount += 1;
      FakeNotification.permission = 'granted';
      return Promise.resolve('granted');
    }
  }
  window.Notification = FakeNotification;

  window.HTMLCanvasElement.prototype.getContext = () => ({
    fillStyle: '',
    fillRect() {},
    beginPath() {},
    arc() {},
    fill() {}
  });
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,test';

  class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.destination = {};
    }
    createOscillator() {
      return {
        type: '',
        frequency: { value: 0 },
        connect() {},
        start() { beepCount += 1; },
        stop() {}
      };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          exponentialRampToValueAtTime() {}
        },
        connect() {}
      };
    }
  }
  window.AudioContext = FakeAudioContext;

  window.eval(SOURCE);
  window.dispatchEvent(new window.Event('load'));
  await delay(2);

  function main() {
    return window.document.querySelector('main');
  }

  async function completeTurn(id) {
    const stop = window.document.createElement('button');
    stop.dataset.testid = 'stop-button';
    main().appendChild(stop);
    await delay(1);

    const turn = window.document.createElement('article');
    turn.dataset.messageAuthorRole = 'assistant';
    turn.dataset.messageId = id;
    turn.textContent = `answer-${id}`;
    main().appendChild(turn);
    await delay(2);

    stop.remove();
    await delay();
  }

  return {
    window,
    menuCommands,
    alerts,
    completeTurn,
    requestPermissionCount: () => requestPermissionCount,
    notificationCount: () => notificationCount,
    beepCount: () => beepCount,
    close: () => window.close()
  };
}

test('v1.5.0 metadataに自動更新URLを持つ', () => {
  assert.match(RAW_SOURCE, /@version\s+1\.5\.0/);
  assert.match(RAW_SOURCE, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/scarecrowx913x\/ChatGPT-Answer-Done-Notifier\/main\/ChatGPT-Answer-Done-Notifier\.user\.js/);
  assert.match(RAW_SOURCE, /@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/scarecrowx913x\/ChatGPT-Answer-Done-Notifier\/main\/ChatGPT-Answer-Done-Notifier\.user\.js/);
});

test('Userscriptメニューから通知権限を要求できる', async (t) => {
  const h = await createHarness({ permission: 'default' });
  t.after(h.close);

  const command = h.menuCommands.get('デスクトップ通知を許可する');
  assert.equal(typeof command, 'function');
  command();
  await Promise.resolve();

  assert.equal(h.requestPermissionCount(), 1);
  assert.ok(h.alerts.some((message) => message.includes('許可済み')));
});

test('回答完了時は通知権限を自動要求しない', async (t) => {
  const h = await createHarness({ permission: 'default', hidden: true, sound: false, notification: true });
  t.after(h.close);

  await h.completeTurn('turn-default-permission');

  assert.equal(h.requestPermissionCount(), 0);
  assert.equal(h.notificationCount(), 0);
});

test('完了turn履歴は上限を超えると古いIDを破棄する', async (t) => {
  const h = await createHarness({ sound: true, notification: false });
  t.after(h.close);

  await h.completeTurn('turn-0');
  await h.completeTurn('turn-0');
  assert.equal(h.beepCount(), 1);

  await h.completeTurn('turn-1');
  await h.completeTurn('turn-2');
  await h.completeTurn('turn-3');
  assert.equal(h.beepCount(), 4);

  await h.completeTurn('turn-0');
  assert.equal(h.beepCount(), 5);
});
