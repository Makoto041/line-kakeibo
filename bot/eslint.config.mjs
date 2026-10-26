// bot の ESLint 設定（flat config）
//
// 型チェックは tsc が担うため、型情報を使わない recommended を土台にする。
// 既存コードで多く出る書き方の指摘は warn に下げ、error は実際の不具合につながるものだけにする。
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// --- ログの書き方の検査（docs/SECURITY_OPERATIONS.md §9。固定文 + オブジェクト、例外は errorFields で種類だけ） ---
//
// console.log / warn / error / info / debug の呼び出し
const CONSOLE_CALL =
  "CallExpression[callee.type='MemberExpression'][callee.object.name='console'][callee.property.name=/^(log|warn|error|info|debug)$/]";
// 例外を入れる変数の名前（e / err / error / 〜Error）。isError / hasError のような真偽値（is・has の次が大文字）は除く
const ERROR_NAME = "[name=/^(e|err|error)$|^(?!(is|has)[A-Z]).*Error$/]";
// 型の注釈（`error as Error`・`error!`）
const TS_WRAPPER = ":matches(TSAsExpression, TSSatisfiesExpression, TSNonNullExpression)";
// 例外の変数が「そのまま」ログに入る位置。関数に渡す（errorFields(error)・errorName(parseError)）・
// プロパティを読む（error.response?.status）・typeof / instanceof は値をそのまま出さないので対象にしない
const ERROR_VALUE_POSITIONS = [
  `${CONSOLE_CALL} > Identifier.arguments`, // console.error('…', error)
  `${CONSOLE_CALL} > ${TS_WRAPPER}.arguments > Identifier.expression`, // console.error('…', error as Error)
  `${CONSOLE_CALL} > SpreadElement > Identifier.argument`, // console.error(...error)
  `${CONSOLE_CALL} ObjectExpression > Property > Identifier.value`, // { error } / { cause: err }（入れ子も）
  `${CONSOLE_CALL} ObjectExpression > Property > ${TS_WRAPPER}.value > Identifier.expression`, // { err: error as Error }
  `${CONSOLE_CALL} ObjectExpression > SpreadElement > Identifier.argument`, // { ...error }（自身のプロパティ = gaxios の config など）
  `${CONSOLE_CALL} ArrayExpression > Identifier.elements`, // [error]
  `${CONSOLE_CALL} TemplateLiteral > Identifier.expressions`, // `${error}`（文字列にすると文言が入る）
  `${CONSOLE_CALL} BinaryExpression[operator='+'] > Identifier`, // '…' + error
  `${CONSOLE_CALL} CallExpression:matches([callee.name='String'], [callee.object.name='JSON'][callee.property.name='stringify']) > Identifier.arguments`, // String(error) / JSON.stringify(error)
  `${CONSOLE_CALL} LogicalExpression:matches([operator='??'], [operator='||']) > Identifier`, // error ?? null
  `${CONSOLE_CALL} ConditionalExpression > Identifier:matches(.consequent, .alternate)`, // ok ? null : error
];
const LOG_SAFETY_RULES = [
  ...[
    `${CONSOLE_CALL} > TemplateLiteral.arguments:first-child`, // console.log(`saved ${id}`)
    // console.log('saved ' + id)。固定の文字列どうしの連結（長い固定文の折り返し）は識別子を含まないので対象外
    `${CONSOLE_CALL} > BinaryExpression.arguments:first-child[operator='+']:has(Identifier)`,
  ].map((selector) => ({
    selector,
    message:
      "ログの 1 つ目の引数は固定の文字列にする（テンプレートリテラルや + の連結で値を埋め込まない）。値は 2 つ目の引数のオブジェクトで渡す（docs/SECURITY_OPERATIONS.md §9）",
  })),
  ...ERROR_VALUE_POSITIONS.map((position) => ({
    selector: `${position}${ERROR_NAME}`,
    message:
      "例外をそのままログに渡さない（生の例外には文言・通信先のヘッダー・応答の本文が入る）。errorFields(error) で種類だけを出す（docs/SECURITY_OPERATIONS.md §9）",
  })),
  {
    selector: `${CONSOLE_CALL} MemberExpression:matches([computed=false][property.name=/^(message|stack)$/], [computed=true][property.value=/^(message|stack)$/])`,
    message:
      "例外の文言（.message）・スタック（.stack）をログに出さない（文書のパスや入力の断片が入る。名前が message のプロパティはすべて対象で、LINE の event.message.text も利用者の入力）。errorFields(error) で種類だけを出す（docs/SECURITY_OPERATIONS.md §9）",
  },
];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // LINE の webhook イベントなど外部入力の型付けが追いついていない箇所が多い
      "@typescript-eslint/no-explicit-any": "warn",
      // 未使用は tsc（--noUnusedLocals）でも見る。`_` 始まりは意図的な未使用として許す
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-non-null-assertion": "off",
      "prefer-const": "warn",
      // 全角スペース（U+3000。「要望」と本文の区切りなど）はコマンドの判定に使うため、文字列内は許す
      "no-irregular-whitespace": ["error", { skipStrings: true, skipTemplates: true }],
    },
  },
  {
    // Cloud Logging に出る bot 本体のログだけを検査する（スクリプトの出力は手元の端末に出るだけなので対象外）。
    // 例外は geminiClient.ts の §7 の行（API のエラー文の先頭 300 文字）だけで、その行に eslint-disable-next-line を付けている。
    // CI の lint は失敗しても落ちないため、bot/src に報告が無いことと重さが error であることは scripts/smoke-log-lint.js（npm test）で確かめる
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...LOG_SAFETY_RULES],
    },
  },
  {
    // スモーク / 統合テストのスクリプトは CommonJS
    files: ["scripts/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  }
);
