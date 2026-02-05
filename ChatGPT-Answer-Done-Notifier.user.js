// ==UserScript==
// @name        ChatGPT Answer Done Notifier
// @namespace   https://github.com/scarecrowx913x/ChatGPT-Answer-Done-Notifier
// @version     1.3.0
// @description ChatGPTの回答完了を検知して、ビープ音＋デスクトップ通知＋ファビコンの緑●バッジで知らせるシンプル通知スクリプト
// @author      scarecrowx913x
// @match       https://chatgpt.com/*
// @match       https://chat.openai.com/*
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_getClipboard
// @grant       GM_registerMenuCommand
// @run-at      document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // どれくらい変化が止まったら「完了」とみなすか（ミリ秒）
  var QUIET_MS = 2500; // ちょっと長めにして、途中の小休止で誤爆しにくく

  // 同じ回答で何度も鳴らないようにするクールダウン（ミリ秒）
  var COOLDOWN_MS = 2000;

  var lastMutationTime = 0;
  var doneTimer = null;

  // 回答が進行中かどうか
  var isAnswering = false;

  // 直近で通知した時刻
  var lastNotifiedAt = 0;

  // 音・通知の個別ON/OFFフラグ（デフォルトは両方ON）
  var soundEnabled = GM_getValue('gptNotifier_soundEnabled', true);
  var notificationEnabled = GM_getValue('gptNotifier_notificationEnabled', true);
  var autoPasteEnabled = GM_getValue('gptNotifier_autoPasteEnabled', true);

  // Observer を二重で付けないためのフラグ
  var observerInitialized = false;

  // AudioContext を1つだけ使い回す
  var audioCtx = null;

  // 元のファビコンとバッジ状態
  var originalFaviconHref = null;
  var faviconBadged = false;

  // ChatGPTのアシスタントメッセージっぽい要素を拾うためのセレクタ
  // UI変更に強くするため、よく使われる属性をまとめて見る
  var ASSISTANT_SELECTOR = [
    '[data-message-author-role="assistant"]',
    '[data-message-author-role*=assistant]',
    '[data-message-id][data-message-author-role]',
    '[data-testid="assistant-message"]'
  ].join(',');

  // 共通ログ
  function log() {
    console.log.apply(console, ['[GPT-Notifier]'].concat(Array.from(arguments)));
  }

  // Tampermonkey のメニュー登録（音・通知を個別に制御）
  function setupMenu() {
    GM_registerMenuCommand(
      'ビープ音のON/OFFを切り替える',
      function () {
        soundEnabled = !soundEnabled;
        GM_setValue('gptNotifier_soundEnabled', soundEnabled);
        alert('ChatGPT通知のビープ音は今 ' + (soundEnabled ? 'ON' : 'OFF') + ' です');
        log('ビープ音の状態を切り替えました →', soundEnabled ? 'ON' : 'OFF');
      }
    );

    GM_registerMenuCommand(
      'デスクトップ通知のON/OFFを切り替える',
      function () {
        notificationEnabled = !notificationEnabled;
        GM_setValue('gptNotifier_notificationEnabled', notificationEnabled);
        alert('ChatGPTのデスクトップ通知は今 ' + (notificationEnabled ? 'ON' : 'OFF') + ' です');
        log('デスクトップ通知の状態を切り替えました →', notificationEnabled ? 'ON' : 'OFF');
      }
    );

    GM_registerMenuCommand(
      '自動貼り付けのON/OFFを切り替える',
      function () {
        autoPasteEnabled = !autoPasteEnabled;
        GM_setValue('gptNotifier_autoPasteEnabled', autoPasteEnabled);
        alert('ChatGPTの自動貼り付けは今 ' + (autoPasteEnabled ? 'ON' : 'OFF') + ' です');
        log('自動貼り付けの状態を切り替えました →', autoPasteEnabled ? 'ON' : 'OFF');
      }
    );

    log('メニュー登録済み（音:' + (soundEnabled ? 'ON' : 'OFF') + ', 通知:' + (notificationEnabled ? 'ON' : 'OFF') + ', 自動貼り付け:' + (autoPasteEnabled ? 'ON' : 'OFF') + '）');
  }

  function setupObserver() {
    // 二重に仕掛けないようにガード
    if (observerInitialized) {
      log('Observerは既に初期化済みなのでスキップ');
      return;
    }

    var target = document.querySelector('main') || document.body;
    if (!target) {
      log('ターゲット要素が見つからないのでリトライ');
      setTimeout(setupObserver, 2000);
      return;
    }

    observerInitialized = true;

    var observer = new MutationObserver(function (mutations) {
      var now = Date.now();
      var touchedAssistant = false;

      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        var node = m.target;
        var el = null;

        // テキストノード(characterData)も拾う
        if (node.nodeType === Node.TEXT_NODE) {
          el = node.parentElement;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          el = node;
        } else {
          continue;
        }

        if (!el) continue;

        // アシスタントメッセージの中 or その近辺かどうか判定
        var host = el.closest(ASSISTANT_SELECTOR);
        if (host) {
          touchedAssistant = true;
          break;
        }
      }

      if (!touchedAssistant) return;

      // 初めての変化なら「この回答の開始」をマーク
      if (!isAnswering) {
        isAnswering = true;
        log('回答開始っぽい変化を検知');
      }

      lastMutationTime = now;

      if (doneTimer) clearTimeout(doneTimer);

      doneTimer = setTimeout(function () {
        // 直近の変化からQUIET_MS以上たっていたら「完了」とみなす
        if (Date.now() - lastMutationTime >= QUIET_MS) {
          notifyDone();
          // 次の回答のためにリセット
          isAnswering = false;
        }
      }, QUIET_MS + 150);
    });

    observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true
    });

    log('MutationObserver セット完了');
  }

  function notifyDone() {
    var now = Date.now();
    if (now - lastNotifiedAt < COOLDOWN_MS) {
      log('クールダウン中のため通知スキップ');
      return;
    }
    lastNotifiedAt = now;

    log('回答完了と判定 → 通知処理を実行');

    // ビープ音（個別ON/OFF）
    if (soundEnabled) {
      playBeep();
    } else {
      log('ビープ音はOFFなのでスキップ');
    }

    // デスクトップ通知＆ファビコンバッジ（個別ON/OFF）
    if (notificationEnabled) {
      showNotification();
      setFaviconBadge(true);
    } else {
      log('デスクトップ通知はOFFなのでスキップ（ファビコンバッジも付けない）');
    }

    if (autoPasteEnabled) {
      pasteClipboardToComposer();
    } else {
      log('自動貼り付けはOFFなのでスキップ');
    }
  }

  function getComposerElement() {
    return document.querySelector('#prompt-textarea') ||
      document.querySelector('textarea[placeholder]') ||
      document.querySelector('[data-testid="prompt-textarea"]') ||
      document.querySelector('div.ProseMirror[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"][role="textbox"]');
  }

  function setNativeValue(el, value) {
    var proto = Object.getPrototypeOf(el);
    var descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
      return;
    }
    el.value = value;
  }

  function insertIntoComposer(target, text) {
    if (!target || !text) return false;

    target.focus();

    var tag = target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      var current = target.value || '';
      var next = current ? current + '\n' + text : text;
      setNativeValue(target, next);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    if (target.isContentEditable) {
      var currentText = (target.textContent || '').trim();
      target.textContent = currentText ? currentText + '\n' + text : text;
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
      return true;
    }

    return false;
  }

  function readClipboardText() {
    if (typeof GM_getClipboard === 'function') {
      try {
        var gmText = GM_getClipboard();
        if (typeof gmText === 'string') {
          return Promise.resolve(gmText);
        }
      } catch (e) {
        log('GM_getClipboard 失敗。navigator.clipboard を試行します。', e);
      }
    }

    if (navigator.clipboard && navigator.clipboard.readText) {
      return navigator.clipboard.readText();
    }

    return Promise.reject(new Error('Clipboard API が利用できません'));
  }

  function pasteClipboardToComposer() {
    readClipboardText()
      .then(function (clipText) {
        var text = (clipText || '').trim();
        if (!text) {
          log('クリップボードが空のため貼り付けをスキップ');
          return;
        }

        var composer = getComposerElement();
        if (!composer) {
          log('入力欄が見つからないため貼り付けできませんでした');
          return;
        }

        var success = insertIntoComposer(composer, text);
        log(success ? 'クリップボード内容を入力欄へ貼り付けました' : '入力欄への貼り付けに失敗しました');
      })
      .catch(function (e) {
        log('クリップボード読み取りに失敗したため貼り付けできませんでした', e);
      });
  }

  function getAudioCtx() {
    if (!audioCtx) {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioCtx();
    }
    return audioCtx;
  }

  // 単純な「ピッ」を1回鳴らす
  function playBeep() {
    try {
      var ctx = getAudioCtx();
      if (!ctx) return;

      var osc = ctx.createOscillator();
      var gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.value = 880; // 高めの「ピッ」

      osc.connect(gain);
      gain.connect(ctx.destination);

      var t0 = ctx.currentTime;
      gain.gain.setValueAtTime(0.2, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);

      osc.start(t0);
      osc.stop(t0 + 0.25);
    } catch (e) {
      console.warn('ビープ再生失敗', e);
    }
  }

  // 現在のfavicon <link> を取得（なければ作る）
  function getFaviconLink() {
    var link = document.querySelector('link[rel="icon"]') ||
               document.querySelector('link[rel="shortcut icon"]') ||
               document.querySelector('link[rel*="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    return link;
  }

  // ファビコンに●バッジを付ける / 戻す
  function setFaviconBadge(active) {
    var link = getFaviconLink();
    if (!link) return;

    if (!active) {
      if (faviconBadged && originalFaviconHref !== null) {
        link.href = originalFaviconHref;
      }
      faviconBadged = false;
      return;
    }

    if (!faviconBadged) {
      originalFaviconHref = link.href || originalFaviconHref;
    }

    var size = 64;
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');

    // 背景を少し暗めで塗る
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, size, size);

    // 真ん中に●バッジ
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.35, 0, Math.PI * 2, false);
    ctx.fillStyle = '#22c55e';
    ctx.fill();

    link.href = canvas.toDataURL('image/png');
    faviconBadged = true;
  }

  function clearFaviconBadge() {
    setFaviconBadge(false);
  }

  function showNotification() {
    if (!('Notification' in window)) return;

    if (Notification.permission === 'granted') {
      new Notification('ChatGPT', {
        body: '回答の生成が終わったよ 🎉',
        tag: 'chatgpt-answer-done'
      });
    } else if (Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  window.addEventListener('load', function () {
    setTimeout(setupObserver, 2000);
  });

  // 念のため保険でもう一度（observerInitialized で二重起動は防止）
  setTimeout(setupObserver, 5000);

  // タブに戻ってきたらファビコンバッジを消す
  window.addEventListener('focus', clearFaviconBadge);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      clearFaviconBadge();
    }
  });

  // メニュー登録
  setupMenu();
})();
