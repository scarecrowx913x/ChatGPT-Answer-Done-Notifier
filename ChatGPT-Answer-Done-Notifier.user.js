// ==UserScript==
// @name        ChatGPT Answer Done Notifier
// @namespace   https://github.com/scarecrowx913x/ChatGPT-Answer-Done-Notifier
// @version     1.1.0
// @description ChatGPTの回答完了を検知して、ビープ音＋デスクトップ通知＋ファビコンの緑●バッジで知らせるシンプル通知スクリプト（タブ非アクティブ時のみ通知・静寂時間とクールダウンで多重通知を抑制）
// @author      scarecrowx913x
// @match       https://chatgpt.com/*
// @match       https://chat.openai.com/*
// @grant       GM_getValue
// @grant       GM_setValue
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

  // 通知ON/OFFフラグ（デフォルトはON）
  var enabled = GM_getValue('gptNotifier_enabled', true);

  // Observer を二重で付けないためのフラグ
  var observerInitialized = false;

  // AudioContext を1つだけ使い回す
  var audioCtx = null;

  // 元のファビコンとバッジ状態
  var originalFaviconHref = null;
  var faviconBadged = false;

  // 共通ログ
  function log() {
    console.log.apply(console, ['[GPT-Notifier]'].concat(Array.from(arguments)));
  }

  // Tampermonkey のメニュー登録（ラベルは固定）
  function setupMenu() {
    GM_registerMenuCommand(
      '通知機能のON/OFFを切り替える',
      function () {
        enabled = !enabled;
        GM_setValue('gptNotifier_enabled', enabled);
        alert('ChatGPT通知は今 ' + (enabled ? 'ON' : 'OFF') + ' です');
        log('通知状態を切り替えました →', enabled ? 'ON' : 'OFF');
      }
    );
    log('メニュー登録済み（現在の状態: ' + (enabled ? 'ON' : 'OFF') + '）');
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
        if (!(m.target instanceof HTMLElement)) continue;

        if (m.target.closest('[data-message-author-role="assistant"]')) {
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
    // ON/OFFがOFFなら何もしない
    if (!enabled) {
      log('通知はOFFなのでスキップ');
      return;
    }

    var now = Date.now();
    if (now - lastNotifiedAt < COOLDOWN_MS) {
      log('クールダウン中のため通知スキップ');
      return;
    }
    lastNotifiedAt = now;

    log('回答完了と判定 → 通知＆ビープを1回ずつ実行');

    // 常にビープ音は鳴らす
    playBeep();

    // タブを見ていないときだけデスクトップ通知＆ファビコンバッジ
    if (!document.hasFocus()) {
      showNotification();
      setFaviconBadge(true);
    }
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
