# ChatGPT Answer Done Notifier

ChatGPT の回答完了を知らせる Userscript。

- 回答完了時に短いビープ音を 1 回鳴らす
- ChatGPT のタブが裏にある場合はデスクトップ通知を表示する
- ChatGPT のタブが裏にある場合はファビコンへ緑色の ● バッジを付ける

別タブで作業していても、ChatGPT の返事が終わったタイミングに気付きやすくなる。

現在のスクリプト版: **1.5.0**

## インストール

1. ブラウザへ Userscript マネージャ（Tampermonkey / Violentmonkey など）をインストールする
2. [ChatGPT Answer Done Notifier をインストール](https://github.com/scarecrowx913x/ChatGPT-Answer-Done-Notifier/raw/main/ChatGPT-Answer-Done-Notifier.user.js) を開く
3. Userscript マネージャのインストール画面で「インストール」を選ぶ
4. デスクトップ通知を使う場合は、Userscript メニューから `デスクトップ通知を許可する` を一度実行する

直接 URL が必要な場合:

```text
https://raw.githubusercontent.com/scarecrowx913x/ChatGPT-Answer-Done-Notifier/main/ChatGPT-Answer-Done-Notifier.user.js
```

`@updateURL` / `@downloadURL` を設定しているため、対応する Userscript マネージャでは新しい `@version` を自動検出できる。手動更新する場合は同じインストールリンクを開いて上書きする。

## 使い方

1. ChatGPT（`https://chatgpt.com` または `https://chat.openai.com`）を普段どおり開く
2. プロンプトを送信する
3. 回答完了時にビープ音が鳴る
4. ChatGPT のタブが裏にある場合は、デスクトップ通知と緑色の ● ファビコンでも知らせる
5. ChatGPT のタブへ戻ると、ファビコンは元のアイコンへ戻る

## 通知の ON / OFF と権限設定

Userscript マネージャの拡張機能アイコンから本スクリプトのメニューを開くと、次の項目を使える。

- `ビープ音のON/OFFを切り替える`
- `デスクトップ通知のON/OFFを切り替える`
- `デスクトップ通知を許可する`

設定状態はブラウザ側へ保存され、ページを閉じても保持される。

デスクトップ通知の許可ダイアログは、回答完了時には自動表示しない。初回だけ `デスクトップ通知を許可する` をユーザー操作で実行する。

## トラブルシュート

### 音が鳴らない

- ブラウザやタブがミュートになっていないか確認する
- 一部ブラウザでは、最初のクリックなどユーザー操作前の音声再生がブロックされる場合がある

### デスクトップ通知が表示されない

- Userscript メニューから `デスクトップ通知を許可する` を実行する
- すでに拒否している場合は、ブラウザのサイト設定から ChatGPT の通知を許可する
- OS とブラウザの通知設定を確認する
- デスクトップ通知は ChatGPT のタブが裏にあるときだけ表示される

### ファビコンが戻らない

- ChatGPT のタブへ戻る
- 戻らない場合はタブを再読み込みする

## ライセンス

MIT License
