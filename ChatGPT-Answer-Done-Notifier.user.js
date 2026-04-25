// ==UserScript==
// @name         ChatGPT Answer Done Notifier
// @namespace    https://github.com/scarecrowx913x/ChatGPT-Answer-Done-Notifier
// @version      1.3.1
// @description  ChatGPTの回答完了を検知して、ビープ音＋デスクトップ通知＋ファビコンの緑●バッジで知らせるシンプル通知スクリプト
// @author       scarecrowx913x
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // どれくらい変化が止まったら「完了」とみなすか（ミリ秒）
  var QUIET_MS = 2500;

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

  // Observer を二重で付けないためのフラグ
  var observerInitialized = false;

  // AudioContext を1つだけ使い回す
  var audioCtx = null;

  // 元のファビコンとバッジ状態
  var originalFaviconHref = null;
  var faviconBadged = false;

  // ChatGPTのアシスタントメッセージっぽい要素を拾うためのセレクタ
  var ASSISTANT_SELECTOR = [
    '[data-message-author-role="assistant"]',
    '[data-message-author-role*=assistant]',
    '[data-message-id][data-message-author-role]',
    '[data-testid="assistant-message"]'
  ].join(',');

  // 生成中に表示される「Stop」ボタンのセレクタ（複数フォールバック）
  // v1.3.0: Thinkingモードでの多重通知を防ぐために追加
  var STOP_BUTTON_SELECTOR = [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="生成を停止"]',
    '[data-testid="stop-streaming-button"]'
  ].join(',');

  // 生成完了後に表示されるボタン（コピー、評価など）のセレクタ
  // v1.3.0: 完了確認の二重チェックに使用
  var COMPLETION_BUTTON_SELECTOR = [
    'button[data-testid="copy-turn-action-button"]',
    'button[data-testid="good-response-turn-action-button"]',
    'button[aria-label*="Copy"]',
    'button[aria-label*="コピー"]'
  ].join(',');

  // 共通ログ
  function log() {
    console.log.apply(console, ['[GPT-Notifier]'].concat(Array.from(arguments)));
  }

  // Tampermonkey/ViolentMonkey のメニュー登録
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

    log('メニュー登録済み（音:' + (soundEnabled ? 'ON' : 'OFF') + ', 通知:' + (notificationEnabled ? 'ON' : 'OFF') + '）');
  }

  // -------------------------------------------------------
  // v1.3.0: 生成中かどうかをStopボタンの有無で判定
  // Thinkingモードでは「思考フェーズ→回答フェーズ」の切れ目に
  // 一時的なDOM静止が発生するが、Stopボタンはまだ表示されている。
  // これを使うことで、静止=完了の誤判定を防ぐ。
  // -------------------------------------------------------
  function isGenerating() {
    return !!document.querySelector(STOP_BUTTON_SELECTOR);
  }

  // -------------------------------------------------------
  // v1.3.0: 完了後ボタン（コピー等）が最後のアシスタントメッセージに
  // 出現しているかどうかで完了を二重確認
  // -------------------------------------------------------
  function getLastAssistantMessage() {
    var messages = document.querySelectorAll(ASSISTANT_SELECTOR);
    if (!messages || messages.length === 0) return null;
    return messages[messages.length - 1];
  }

  function hasCompletionButtons() {
    var lastMsg = getLastAssistantMessage();
    if (!lastMsg) return false;
    return !!lastMsg.querySelector(COMPLETION_BUTTON_SELECTOR);
  }

  // -------------------------------------------------------
  // v1.3.0: 完了判定を独立した関数に切り出し
  // Stopボタンがまだある場合は500msごとに再チェックする。
  // Thinkingモードの「思考→回答」の空白期間をこれで乗り越える。
  // -------------------------------------------------------
  function checkCompletion() {
    // 静止時間がまだ足りない場合はスキップ
    if (Date.now() - lastMutationTime < QUIET_MS) return;

    // Stopボタンが残っていればまだ生成中（Thinkingモードの思考→回答の空白 or フェーズ切替）
    if (isGenerating()) {
      log('Stopボタンが残っているため待機中（Thinkingモード対応）...');
      doneTimer = setTimeout(checkCompletion, 500);
      return;
    }

    // 完了後ボタンが出ていればより確実に完了と判断（出ていなくても通知はする）
    if (hasCompletionButtons()) {
      log('完了ボタン確認 → 回答完了と判定');
    } else {
      log('完了ボタン未確認だが、Stopボタンも消えているため完了と判定');
    }

    notifyDone();
    isAnswering = false;
  }

  function setupObserver() {
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

        if (node.nodeType === Node.TEXT_NODE) {
          el = node.parentElement;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          el = node;
        } else {
          continue;
        }

        if (!el) continue;

        var host = el.closest(ASSISTANT_SELECTOR);
        if (host) {
          touchedAssistant = true;
          break;
        }
      }

      if (!touchedAssistant) return;

      if (!isAnswering) {
        isAnswering = true;
        log('回答開始っぽい変化を検知');
      }

      lastMutationTime = now;

      if (doneTimer) clearTimeout(doneTimer);

      // v1.3.0: インライン関数→ checkCompletion() に変更
      // Thinkingモード対応のため、Stopボタンの有無を繰り返しチェックする
      doneTimer = setTimeout(checkCompletion, QUIET_MS + 150);
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

    if (soundEnabled) {
      playBeep();
    } else {
      log('ビープ音はOFFなのでスキップ');
    }

    if (notificationEnabled) {
      // 通知とバッジはタブが非アクティブ時だけ表示する
      if (document.hidden) {
        showNotification();
        setFaviconBadge(true);
      } else {
        log('タブがアクティブのため、デスクトップ通知とファビコンバッジはスキップ');
      }
    } else {
      log('デスクトップ通知はOFFなのでスキップ（ファビコンバッジも付けない）');
    }
  }

  function getAudioCtx() {
    if (!audioCtx) {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioCtx();
    }
    return audioCtx;
  }

  function playBeep() {
    try {
      var ctx = getAudioCtx();
      if (!ctx) return;

      var osc = ctx.createOscillator();
      var gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.value = 880;

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

    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, size, size);

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

  setTimeout(setupObserver, 5000);

  window.addEventListener('focus', clearFaviconBadge);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      clearFaviconBadge();
    }
  });

  setupMenu();
})();
