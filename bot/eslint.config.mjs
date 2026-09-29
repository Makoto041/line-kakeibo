// bot の ESLint 設定（flat config）
//
// 型チェックは tsc が担うため、型情報を使わない recommended を土台にする。
// 既存コードで多く出る書き方の指摘は warn に下げ、error は実際の不具合につながるものだけにする。
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

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
