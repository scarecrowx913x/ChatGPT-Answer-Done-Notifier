// ==UserScript==
// @name         ChatGPT Answer Done Notifier
// @namespace    https://github.com/scarecrowx913x/ChatGPT-Answer-Done-Notifier
// @version      1.4.0
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

  var QUIET_MS = 2500;
  var COOLDOWN_MS = 2000;

  var lastMutationTime = 0;
  var doneTimer = null;
  var lastNotifiedAt = 0;

  var soundEnabled = GM_getValue('gptNotifier_soundEnabled', true);
  var notificationEnabled = GM_getValue('gptNotifier_notificationEnabled', true);

  var observerInitialized = false;
  var audioCtx = null;
  var originalFaviconHref = null;
  var faviconBadged = false;

  // 回答単位の状態を追跡する。
  // data-message-id がある場合はそれをturn IDとして使い、ない場合だけDOM要素単位のIDを割り当てる。
  var activeTurn = null;
  var completedTurnIds = new Set();
  var fallbackTurnIds = new WeakMap();
  var fallbackTurnSequence = 0;
  var generationObserved = false;
  var observedLocation = window.location.href;

  var ASSISTANT_SELECTOR = [
    '[data-message-author-role="assistant"]',
    '[data-message-author-role*=assistant]',
    '[data-message-id][data-message-author-role="assistant"]',
    '[data-testid="assistant-message"]'
  ].join(',');

  var STOP_BUTTON_SELECTOR = [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="生成を停止"]',
    '[data-testid="stop-streaming-button"]'
  ].join(',');

  var COMPLETION_BUTTON_SELECTOR = [
    'button[data-testid="copy-turn-action-button"]',
    'button[data-testid="good-response-turn-action-button"]',
    'button[aria-label*="Copy"]',
    'button[aria-label*="コピー"]'
  ].join(',');

  function log() {
    console.log.apply(console, ['[GPT-Notifier]'].concat(Array.from(arguments)));
  }

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

  function isGenerating() {
    return !!document.querySelector(STOP_BUTTON_SELECTOR);
  }

  function nodeContainsStopButton(node) {
    var el = null;

    if (node.nodeType === Node.ELEMENT_NODE) {
      el = node;
    } else if (node.nodeType === Node.TEXT_NODE) {
      el = node.parentElement;
    }

    if (!el) return false;
    if (el.matches && el.matches(STOP_BUTTON_SELECTOR)) return true;
    return !!(el.querySelector && el.querySelector(STOP_BUTTON_SELECTOR));
  }

  function mutationsShowGeneration(mutations) {
    if (isGenerating()) return true;

    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (!m.addedNodes || !m.addedNodes.length) continue;

      for (var j = 0; j < m.addedNodes.length; j++) {
        if (nodeContainsStopButton(m.addedNodes[j])) return true;
      }
    }

    return false;
  }

  function mutationsRemoveStopButton(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (!m.removedNodes || !m.removedNodes.length) continue;

      for (var j = 0; j < m.removedNodes.length; j++) {
        if (nodeContainsStopButton(m.removedNodes[j])) return true;
      }
    }

    return false;
  }

  function addedNodeContainsAssistant(node) {
    var el = null;

    if (node.nodeType === Node.ELEMENT_NODE) {
      el = node;
    } else if (node.nodeType === Node.TEXT_NODE) {
      el = node.parentElement;
    }

    if (!el) return false;
    if (el.matches && el.matches(ASSISTANT_SELECTOR)) return true;
    return !!(el.querySelector && el.querySelector(ASSISTANT_SELECTOR));
  }

  function mutationsAddAssistant(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (!m.addedNodes || !m.addedNodes.length) continue;

      for (var j = 0; j < m.addedNodes.length; j++) {
        if (addedNodeContainsAssistant(m.addedNodes[j])) return true;
      }
    }

    return false;
  }

  function resetTrackingOnNavigation() {
    var currentLocation = window.location.href;
    if (currentLocation === observedLocation) return;

    observedLocation = currentLocation;
    activeTurn = null;
    generationObserved = false;
    if (doneTimer) {
      clearTimeout(doneTimer);
      doneTimer = null;
    }
    log('SPA画面遷移を検知 → turn追跡をリセット');
  }

  function canonicalizeAssistantHost(message) {
    if (!message) return null;

    var canonical = message;
    var parent = canonical.parentElement;
    while (parent) {
      if (parent.matches && parent.matches(ASSISTANT_SELECTOR)) {
        canonical = parent;
      }
      parent = parent.parentElement;
    }
    return canonical;
  }

  function getLastAssistantMessage() {
    var messages = document.querySelectorAll(ASSISTANT_SELECTOR);
    if (!messages || messages.length === 0) return null;
    return canonicalizeAssistantHost(messages[messages.length - 1]);
  }

  function getTurnId(message) {
    if (!message) return null;

    var messageId = message.getAttribute('data-message-id');
    if (messageId) return 'message:' + messageId;

    if (!fallbackTurnIds.has(message)) {
      fallbackTurnSequence += 1;
      fallbackTurnIds.set(message, 'element:' + fallbackTurnSequence);
    }
    return fallbackTurnIds.get(message);
  }

  function hasCompletionButtons(message) {
    if (!message) return false;
    return !!message.querySelector(COMPLETION_BUTTON_SELECTOR);
  }

  function beginOrContinueTurn(message, now) {
    if (!message) return false;

    message = canonicalizeAssistantHost(message);
    var lastMessage = getLastAssistantMessage();
    if (lastMessage !== message) {
      // 過去回答の再描画やボタン追加は回答開始として扱わない。
      return false;
    }

    var turnId = getTurnId(message);
    if (!turnId || completedTurnIds.has(turnId)) {
      return false;
    }

    if (!activeTurn || activeTurn.id !== turnId) {
      // 新しいturn開始には生成中シグナルが必要。
      // SPA遷移で過去会話一式が追加された場合はStopボタンがないため誤通知しない。
      if (!generationObserved) {
        return false;
      }

      activeTurn = {
        id: turnId,
        element: message
      };
      log('新しいassistant turnを検知 →', turnId);
    } else {
      activeTurn.element = message;
    }

    lastMutationTime = now;
    return true;
  }

  function checkCompletion() {
    if (!activeTurn) return;

    if (Date.now() - lastMutationTime < QUIET_MS) return;

    var lastMessage = getLastAssistantMessage();
    var lastTurnId = getTurnId(lastMessage);

    // active turnが最新turnではなくなった場合、古いturnを完了通知しない。
    if (!lastMessage || lastTurnId !== activeTurn.id) {
      log('active turnが最新ではないため完了判定を破棄 →', activeTurn.id);
      activeTurn = null;
      generationObserved = false;
      return;
    }

    if (completedTurnIds.has(activeTurn.id)) {
      activeTurn = null;
      generationObserved = false;
      return;
    }

    if (isGenerating()) {
      log('Stopボタンが残っているため待機中（Thinkingモード対応）...');
      doneTimer = setTimeout(checkCompletion, 500);
      return;
    }

    if (hasCompletionButtons(lastMessage)) {
      log('完了ボタン確認 → 回答完了と判定');
    } else {
      log('完了ボタン未確認だが、Stopボタンも消えているため完了と判定');
    }

    completedTurnIds.add(activeTurn.id);
    notifyDone();
    log('assistant turn完了 →', activeTurn.id);
    activeTurn = null;
    generationObserved = false;
  }

  function getAssistantHostFromTarget(node) {
    var el = null;

    if (node.nodeType === Node.TEXT_NODE) {
      el = node.parentElement;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      el = node;
    }

    if (!el) return null;

    var host = null;
    if (el.matches && el.matches(ASSISTANT_SELECTOR)) {
      host = el;
    } else if (el.closest) {
      host = el.closest(ASSISTANT_SELECTOR);
    }
    return canonicalizeAssistantHost(host);
  }

  function getAssistantHostFromAddedNode(node) {
    var el = null;

    if (node.nodeType === Node.TEXT_NODE) {
      el = node.parentElement;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      el = node;
    }

    if (!el) return null;

    var host = null;
    if (el.matches && el.matches(ASSISTANT_SELECTOR)) {
      host = el;
    } else if (el.closest) {
      host = el.closest(ASSISTANT_SELECTOR);
    }
    if (host) return canonicalizeAssistantHost(host);

    // 子孫探索は実際に追加されたノードだけに限定する。
    // Mutation targetの祖先から既存の過去回答を拾う誤検知を防ぐ。
    if (el.querySelectorAll) {
      var descendants = el.querySelectorAll(ASSISTANT_SELECTOR);
      if (descendants && descendants.length) {
        return canonicalizeAssistantHost(descendants[descendants.length - 1]);
      }
    }
    return null;
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
      var touchedActiveTurn = false;

      resetTrackingOnNavigation();
      if (mutationsShowGeneration(mutations)) {
        generationObserved = true;
      }

      // Stopボタンだけ観測した後、assistant turn生成前にキャンセル/失敗した場合、
      // generationObservedを残さない。過去assistantの後続DOM変更を新規turnと誤認するのを防ぐ。
      if (
        generationObserved &&
        !activeTurn &&
        !isGenerating() &&
        mutationsRemoveStopButton(mutations) &&
        !mutationsAddAssistant(mutations)
      ) {
        generationObserved = false;
        log('assistant turn開始前に生成終了 → generation stateをクリア');
      }

      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        var targetHost = getAssistantHostFromTarget(m.target);

        if (targetHost && beginOrContinueTurn(targetHost, now)) {
          touchedActiveTurn = true;
          break;
        }

        if (m.addedNodes && m.addedNodes.length) {
          for (var j = 0; j < m.addedNodes.length; j++) {
            var addedHost = getAssistantHostFromAddedNode(m.addedNodes[j]);
            if (addedHost && beginOrContinueTurn(addedHost, now)) {
              touchedActiveTurn = true;
              break;
            }
          }
        }

        if (touchedActiveTurn) break;
      }

      if (!touchedActiveTurn) return;

      if (doneTimer) clearTimeout(doneTimer);
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

    log('回答完了と判定 → 通知処理を実行');

    var notified = false;

    if (soundEnabled) {
      playBeep();
      notified = true;
    } else {
      log('ビープ音はOFFなのでスキップ');
    }

    if (notificationEnabled) {
      if (document.hidden) {
        showNotification();
        setFaviconBadge(true);
        notified = true;
      } else {
        log('タブがアクティブのため、デスクトップ通知とファビコンバッジはスキップ');
      }
    } else {
      log('デスクトップ通知はOFFなのでスキップ（ファビコンバッジも付けない）');
    }

    if (notified) {
      lastNotifiedAt = now;
    } else {
      log('通知手段を実行していないためcooldownは消費しない');
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
