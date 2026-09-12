const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SCRIPT_PATH = path.join(__dirname, '..', 'ChatGPT-Answer-Done-Notifier.user.js');
const RAW_SOURCE = fs.readFileSync(SCRIPT_PATH, 'utf8');
const SOURCE = RAW_SOURCE
  .replace('var QUIET_MS = 2500;', 'var QUIET_MS = 20;')
  .replace('var COOLDOWN_MS = 2000;', 'var COOLDOWN_MS = 5;')
  .replace('setTimeout(setupObserver, 2000);', 'setTimeout(setupObserver, 0);')
  .replace('setTimeout(setupObserver, 5000);', 'setTimeout(setupObserver, 0);')
  .replace('doneTimer = setTimeout(checkCompletion, QUIET_MS + 150);', 'doneTimer = setTimeout(checkCompletion, QUIET_MS + 5);')
  .replace('doneTimer = setTimeout(checkCompletion, 500);', 'doneTimer = setTimeout(checkCompletion, 10);');

function delay(ms = 35) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createHarness({ hidden = false, sound = true, notification = true, html = '<main></main>' } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><link rel="icon" href="/favicon.ico"></head><body>${html}</body></html>`, {
    url: 'https://chatgpt.com/c/test',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const store = new Map([
    ['gptNotifier_soundEnabled', sound],
    ['gptNotifier_notificationEnabled', notification]
  ]);
  let beepCount = 0;
  let notificationCount = 0;

  Object.defineProperty(window.document, 'hidden', {
    configurable: true,
    get: () => hidden
  });

  window.GM_getValue = (key, fallback) => store.has(key) ? store.get(key) : fallback;
  window.GM_setValue = (key, value) => store.set(key, value);
  window.GM_registerMenuCommand = () => {};
  window.alert = () => {};

  class FakeNotification {
    static permission = 'granted';
    constructor() {
      notificationCount += 1;
    }
    static requestPermission() {
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
  await delay(10);

  function setHidden(value) {
    hidden = value;
  }

  function main() {
    return window.document.querySelector('main');
  }

  function addStop(parent = main()) {
    const button = window.document.createElement('button');
    button.dataset.testid = 'stop-button';
    parent.appendChild(button);
    return button;
  }

  function addAssistant(id, parent = main()) {
    const turn = window.document.createElement('article');
    turn.dataset.messageAuthorRole = 'assistant';
    turn.dataset.messageId = id;
    const content = window.document.createElement('div');
    content.dataset.testid = 'assistant-message';
    content.textContent = `answer-${id}`;
    turn.appendChild(content);
    parent.appendChild(turn);
    return turn;
  }

  function addUser(parent = main()) {
    const turn = window.document.createElement('article');
    turn.dataset.messageAuthorRole = 'user';
    turn.textContent = 'user';
    parent.appendChild(turn);
    return turn;
  }

  async function completeTurn(id, parent = main()) {
    const stop = addStop(parent);
    await delay(1);
    const turn = addAssistant(id, parent);
    await delay(5);
    stop.remove();
    await delay();
    return turn;
  }

  return {
    window,
    dom,
    main,
    addStop,
    addAssistant,
    addUser,
    completeTurn,
    setHidden,
    beepCount: () => beepCount,
    notificationCount: () => notificationCount,
    close: () => window.close()
  };
}

test('通常回答で1回だけ通知する', async (t) => {
  const h = await createHarness();
  t.after(h.close);
  await h.completeTurn('turn-1');
  assert.equal(h.beepCount(), 1);
});

test('Thinking中の一時静止では通知せず、Stop消失後に通知する', async (t) => {
  const h = await createHarness();
  t.after(h.close);
  const stop = h.addStop();
  await delay(1);
  h.addAssistant('turn-1');
  await delay(45);
  assert.equal(h.beepCount(), 0);
  stop.remove();
  await delay();
  assert.equal(h.beepCount(), 1);
});

test('userメッセージ追加では通知しない', async (t) => {
  const h = await createHarness();
  t.after(h.close);
  const stop = h.addStop();
  await delay(1);
  h.addUser();
  stop.remove();
  await delay();
  assert.equal(h.beepCount(), 0);
});

test('過去assistantのDOM変更では通知しない', async (t) => {
  const h = await createHarness({
    html: '<main><article data-message-author-role="assistant" data-message-id="old"><div data-testid="assistant-message">old</div></article></main>'
  });
  t.after(h.close);
  const old = h.window.document.querySelector('[data-message-id="old"]');
  old.appendChild(h.window.document.createElement('button'));
  await delay();
  assert.equal(h.beepCount(), 0);
});

test('同一turnの後続DOM変更で多重通知しない', async (t) => {
  const h = await createHarness();
  t.after(h.close);
  const turn = await h.completeTurn('turn-1');
  turn.appendChild(h.window.document.createElement('button'));
  await delay();
  assert.equal(h.beepCount(), 1);
});

test('連続する別turnはそれぞれ通知する', async (t) => {
  const h = await createHarness();
  t.after(h.close);
  await h.completeTurn('turn-1');
  await h.completeTurn('turn-2');
  assert.equal(h.beepCount(), 2);
});

test('foregroundではdesktop通知を出さず、backgroundでは通知する', async (t) => {
  const h = await createHarness({ sound: false, notification: true, hidden: false });
  t.after(h.close);
  await h.completeTurn('turn-1');
  assert.equal(h.notificationCount(), 0);
  h.setHidden(true);
  await h.completeTurn('turn-2');
  assert.equal(h.notificationCount(), 1);
});

test('main差し替え後も監視を継続する', async (t) => {
  const h = await createHarness();
  t.after(h.close);
  const oldMain = h.main();
  const newMain = h.window.document.createElement('main');
  oldMain.replaceWith(newMain);
  await delay(5);
  await h.completeTurn('turn-after-navigation', newMain);
  assert.equal(h.beepCount(), 1);
});
