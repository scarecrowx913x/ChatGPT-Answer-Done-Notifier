# ChatGPT Answer Done Notifier

ChatGPT の回答完了を知らせる Userscript。

- 回答完了時に短いビープ音を 1 回鳴らす
- ChatGPT のタブが裏にある場合はデスクトップ通知を表示する
- ChatGPT のタブが裏にある場合はファビコンへ緑色の ● バッジを付ける

別タブで作業していても、ChatGPT の返事が終わったタイミングに気付きやすくなる。

現在のスクリプト版: **1.4.0**

## インストール

1. ブラウザへ Userscript マネージャ（Tampermonkey / Violentmonkey など）をインストールする
2. [ChatGPT Answer Done Notifier をインストール](https://github.com/scarecrowx913x/ChatGPT-Answer-Done-Notifier/raw/main/ChatGPT-Answer-Done-Notifier.user.js) を開く
3. Userscript マネージャのインストール画面で「インストール」を選ぶ

直接 URL が必要な場合:

```text
https://raw.githubusercontent.com/scarecrowx913x/ChatGPT-Answer-Done-Notifier/main/ChatGPT-Answer-Done-Notifier.user.js
```

更新時は同じインストールリンクを開き、Userscript マネージャ側で上書き更新する。

## 使い方

1. ChatGPT（`https://chatgpt.com` または `https://chat.openai.com`）を普段どおり開く
2. プロンプトを送信する
3. 回答完了時にビープ音が鳴る
4. ChatGPT のタブが裏にある場合は、デスクトップ通知と緑色の ● ファビコンでも知らせる
5. ChatGPT のタブへ戻ると、ファビコンは元のアイコンへ戻る

## 通知の ON / OFF

Userscript マネージャの拡張機能アイコンから本スクリプトのメニューを開くと、次の 2 項目を切り替えられる。

- `ビープ音のON/OFFを切り替える`
- `デスクトップ通知のON/OFFを切り替える`

設定状態はブラウザ側へ保存され、ページを閉じても保持される。

## トラブルシュート

### 音が鳴らない

- ブラウザやタブがミュートになっていないか確認する
- 一部ブラウザでは、最初のクリックなどユーザー操作前の音声再生がブロックされる場合がある

### デスクトップ通知が表示されない

- OS とブラウザの通知設定を確認する
- 通知権限が未設定の場合、通知権限の許可ダイアログが表示されたら「許可」を選ぶ
- デスクトップ通知は ChatGPT のタブが裏にあるときだけ表示される

### ファビコンが戻らない

- ChatGPT のタブへ戻る
- 戻らない場合はタブを再読み込みする

## ライセンス

MIT License
