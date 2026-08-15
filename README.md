# Minecraft Bedrock World Generator

Minecraft Bedrock Edition向けの、ブラウザ内だけで `.mcworld` を生成するMVPです。World Name、signed 64-bit Seed、Difficultyを変更し、Survival・Cheats OFF状態を維持します。ワールドデータのアップロード、アカウント、生成用バックエンドは使いません。

## 起動

```powershell
npm ci
npm run dev
```

表示されたURL（通常は `http://localhost:3000/`）を開きます。

## GitHub Pages

公開先は <https://syunrai331.github.io/CWG/> です。Next.jsのstatic exportを使用し、GitHub Pagesではサーバー処理を実行しません。

```powershell
npm run build:pages
```

このコマンドは `/CWG/` をbase pathとして `out/` を生成します。CSS、JavaScript、`template.mcworld`、`template-manifest.json` も同じbase pathから読み込みます。`out/` は生成物なのでGitへ追加する必要はありません。

`main` ブランチへのpush時は `.github/workflows/deploy-pages.yml` が依存関係のインストール、lint、型チェック、テスト、static exportを実行し、成功した `out/` をGitHub Pagesへデプロイします。GitHubリポジトリでは **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に設定してください。

## 生成手順

1. World Nameを入力。
2. Seedを入力、空欄のまま、またはRandomを選択。
3. Difficultyを選択。
4. Generate Worldを押して `.mcworld` を保存。

Seedは入力、乱数生成、NBT書き込みの全工程で `BigInt` として扱い、JavaScriptの `Number` へ変換しません。

## 新しいスポーン配置方式

テンプレートには生成済みOverworldチャンクを1つも含めません。したがって、スポーン周辺はMinecraft自身がユーザー指定Seedから通常生成します。旧方式の座標 `100000,100,100000` とChunk `6250,6250` は削除済みです。

配置は次の順で行われます。

1. テンプレートのEnd次元の空中にある3個の一時Command Blockを、1チャンクのticking areaで待機させる。
2. 最初のプレイヤーを検出すると、そのプレイヤーの現在位置を基準にする。通常はMinecraftが指定Seedの地形から決定した初期スポーン位置と地表Yです。
3. プレイヤーからワールドX方向へ2ブロックの位置について、縦2ブロックが両方とも空気であることを確認する。
4. 空気の場合だけ、保存済みの1×2×1構造物を配置する。
5. 構造物は下がCommand Block、上がStone Button。Command Block内は `gamemode c @p`。
6. 配置成功後、ticking areaを削除し、一時Command Block 3個も空気へ戻す。

初期位置のX+2側が壁、木、水などで塞がれている場合は地形を上書きせず待機します。プレイヤーが少し移動し、X+2側に縦2ブロックの空気ができた時点で配置されます。

Behavior PackやScript APIは使用していません。Minecraft公式は、実績対応Add-Onについて「Marketplace配布Add-On」が対象で、ローカル改造Packは対象外と説明しているためです。

## テンプレートに残る生成済みデータ

- Overworld生成済みチャンク: 0
- 旧Overworld Chunk `6250,6250`: 0
- End bootstrap Chunk: `32,32` の1チャンク
- End内bootstrap位置: `512,250,512` から3ブロック
- 保存構造物: `mvp:creative_switch`
- Behavior Pack / Resource Pack: なし

End bootstrapは中央島と外島の間の空中かつY=250に置かれています。スポーン周辺のOverworld地形とは分離されています。

## 生成時に固定する値

| NBT | 値 | 意図 |
|---|---:|---|
| `GameType` | `0` | Survival |
| `ForceGameType` | `0` | Game Modeを強制変更しない |
| `Difficulty` | `0..3` | UI選択値 |
| `RandomSeed` | signed 64-bit | UI入力または暗号学的乱数 |
| `cheatsEnabled` | `0` | Cheats OFF |
| `commandsEnabled` | `0` | チャット等のコマンドOFF |
| `hasBeenLoadedInCreative` | `0` | Creative使用履歴なし |
| `commandblocksenabled` | `1` | Command Block有効 |
| `IsHardcore` | `0` | 通常Survival |
| `experiments_ever_used` | `0` | 実験機能使用なし |
| `saved_with_toggled_experiments` | `0` | 実験トグル履歴なし |

`abilities` の `flying`、`instabuild`、`invulnerable`、`mayfly` も `0` に戻します。

## 根拠と実測

- [Minecraft Help: Bedrock achievements](https://help.minecraft.net/hc/en-us/articles/4409244237325-Unlock-Minecraft-Bedrock-Edition-Achievements) — Survival、Cheats、Creative、実験機能などの実績条件。
- [Minecraft: Achievements now work with add-ons](https://www.minecraft.net/en-us/article/achievements-now-work-with-add-ons) — 実績対応はMarketplace配布Add-Onが対象で、ローカルmodは対象外。
- [Microsoft Learn: commandblocksenabled](https://learn.microsoft.com/en-us/minecraft/creator/documents/commandspopularcommands?view=minecraft-bedrock-stable) — Command Block有効化は独立したゲームルール。
- [Bedrock 26.34/35 Hotfix](https://feedback.minecraft.net/hc/en-us/articles/47592941525517-Minecraft-Bedrock-Edition-26-34-35-Hotfix-Changelog) — 2026-08-15時点の安定版情報。

テンプレートはBedrock Dedicated Server `1.26.33.2`で作成しました。Cheats OFF、`commandsEnabled=0`、Creative履歴なしの最終テンプレートをBDSで再起動し、End bootstrapのRepeating Command Blockがロードされ、プレイヤー待機コマンドを継続評価することを確認しています。プレイヤー不在のため、スポーンへの構造物配置成功はMinecraftクライアント側の確認項目です。

## 自動テスト

```powershell
npm test
npm run lint
npm run typecheck
npm run build
npm run build:pages
```

`npm test` はGitHub Pages用のstatic exportを作成したうえで、以下を確認します。

- `/CWG/` 配下のCSS、JavaScript、テンプレート参照と実ファイルの一致
- GitHub Pages用 `.nojekyll` とstatic export構造
- `.mcworld` ZIPルート構造
- `level.dat` / `level.dat_old` のBedrockヘッダーとlittle-endian NBT
- World Name、signed 64-bit Seed、Difficultyの書き換えと再解析
- Survival、Cheats OFF、Creative履歴なし、Command Block有効
- テンプレートDBのSHA-256
- Overworld生成済みチャンクが0件
- 旧Chunk `6250,6250`が全次元に存在しない
- End bootstrap Chunk `32,32`だけが存在する
- bootstrapの配置・後始末コマンド
- 保存構造物内のCommand Block、`gamemode c @p`、Stone Button、上面設置状態
- Behavior Packが含まれないこと

## Minecraft実機で確認する項目

1. `.mcworld` を最新版のWindows / Android / iOS版へImportできる。
2. 指定したWorld Name、Seed、Difficultyで開ける。
3. Survivalで、実績無効警告が表示されない。
4. 初回スポーン後、X+2側付近にCommand Blockと上面Buttonが現れる。現れない場合は数ブロック移動して空気2ブロックを確保する。
5. Buttonを押すと最寄りプレイヤーがCreativeになる。
6. Creative変更後も実績解除可能性が維持される。
7. スポーン周辺の地形とチャンク境界が指定Seed本来の形になっている。
8. Realmへのアップロード、再ダウンロード後も配置・フラグ・実績状態が維持される。

Minecraftクライアントの実績UI、実績の実解除、Creative変更後、Android / iOS、Realms往復は自動確認済みとは扱っていません。

## 主なファイル

- `app/lib/bedrock-nbt.ts` — 必要最小限のlittle-endian NBT reader/writer
- `app/lib/world-generator.ts` — テンプレート検証、設定変更、ZIP再生成
- `app/components/WorldGenerator.tsx` — 最小UI
- `public/template.mcworld` — Overworld未生成テンプレート
- `public/template-manifest.json` — DB整合性と配置契約
- `.github/workflows/deploy-pages.yml` — GitHub Pages自動ビルド・デプロイ
- `tests/static-export.test.mjs` — `/CWG/` static exportと公開アセットの検査
- `tools/finalize-template.mjs` — テンプレート確定・検査用
- `tests/world-generator.test.ts` — NBT / ZIP / LevelDB / 構造物テスト
