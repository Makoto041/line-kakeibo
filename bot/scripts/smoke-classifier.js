/**
 * カテゴリ判定（geminiCategoryClassifier）のスモークテスト
 *
 * Gemini API と Firestore は呼ばずに、判定の順序（キーワード辞書と Gemini のどちらを先に使うか）、
 * Gemini が使えないときのフォールバック、プロンプトの中身を検証する。
 *   node bot/scripts/smoke-classifier.js
 */
const geminiClient = require('../dist/geminiClient');
const firestore = require('../dist/firestore');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Gemini と Firestore を差し替える（classifier は呼び出し時に exports を参照する）
let geminiCalls = [];
let geminiReply = null;
geminiClient.generateJson = async (prompt, options) => {
  geminiCalls.push({ prompt, options });
  return geminiReply;
};
firestore.getAllUserCategories = async () => [];

const { classifyExpenseWithGemini, buildClassificationPrompt } = require('../dist/geminiCategoryClassifier');

async function main() {
  console.log('\n# 既定モデル');
  check('既定は gemini-3.5-flash-lite', geminiClient.DEFAULT_GEMINI_MODEL === 'gemini-3.5-flash-lite');
  delete process.env.GEMINI_MODEL;
  check('GEMINI_MODEL 未設定なら既定', geminiClient.geminiModel() === 'gemini-3.5-flash-lite');
  process.env.GEMINI_MODEL = ' gemini-3.8-flash ';
  check('GEMINI_MODEL で差し替え', geminiClient.geminiModel() === 'gemini-3.8-flash');
  delete process.env.GEMINI_MODEL;

  console.log('\n# コードブロックの除去');
  check('```json を外す', geminiClient.stripCodeFence('```json\n{"a":1}\n```') === '{"a":1}');
  check('素の JSON はそのまま', geminiClient.stripCodeFence('{"a":1}') === '{"a":1}');

  process.env.GEMINI_API_KEY = 'test-key';

  console.log('\n# LINE の入力（text）: 辞書が当たれば Gemini を呼ばない');
  geminiCalls = [];
  geminiReply = { category: '娯楽', confidence: 0.9 };
  let r = await classifyExpenseWithGemini('U_text', 'ランチ');
  check('ランチ → 食費（辞書）', r.category === '食費', JSON.stringify(r));
  check('Gemini は呼ばれない', geminiCalls.length === 0);

  console.log('\n# LINE の入力（text）: 辞書で決まらなければ Gemini');
  geminiCalls = [];
  geminiReply = { category: '娯楽', confidence: 0.8 };
  r = await classifyExpenseWithGemini('U_text', 'ボルダリング');
  check('Gemini の結果を採用', r.category === '娯楽', JSON.stringify(r));
  check('Gemini を 1 回呼ぶ', geminiCalls.length === 1);
  check('スキーマで一覧に限定', Array.isArray(geminiCalls[0]?.options?.schema?.properties?.category?.enum));

  console.log('\n# カード利用通知の店名（merchant）: 辞書より Gemini を優先');
  geminiCalls = [];
  geminiReply = { category: '交通費', confidence: 0.9 };
  // "ENEOS" は辞書では当たらない。"AUTOBACS" は辞書の "au"（通信費）に誤って一致する例
  r = await classifyExpenseWithGemini('gmail-auto-system', 'AUTOBACS ｵｰﾄﾊﾞｯｸｽ', { source: 'merchant' });
  check('辞書の誤一致（au→通信費）ではなく Gemini の結果', r.category === '交通費', JSON.stringify(r));
  check('Gemini を呼ぶ', geminiCalls.length === 1);
  check('店名用のプロンプト', /利用明細/.test(geminiCalls[0]?.prompt || ''));

  console.log('\n# merchant: Gemini が失敗したら辞書にフォールバック（結果はキャッシュしない）');
  geminiCalls = [];
  geminiReply = null;
  r = await classifyExpenseWithGemini('gmail-auto-system', 'ﾛｰｿﾝ ローソン', { source: 'merchant' });
  check('辞書でローソン → 食費', r.category === '食費', JSON.stringify(r));
  geminiReply = { category: '日用品', confidence: 0.7 };
  r = await classifyExpenseWithGemini('gmail-auto-system', 'ﾛｰｿﾝ ローソン', { source: 'merchant' });
  check('復旧後は Gemini で判定し直す', r.category === '日用品', JSON.stringify(r));

  console.log('\n# merchant: 一覧に無いカテゴリは採用しない');
  geminiReply = { category: '謎カテゴリ', confidence: 0.9 };
  r = await classifyExpenseWithGemini('gmail-auto-system', 'XYZ SHOP', { source: 'merchant' });
  check('採用しない（呼び出し側で「その他」）', r.category === null, JSON.stringify(r));

  console.log('\n# GEMINI_API_KEY が無いとき');
  delete process.env.GEMINI_API_KEY;
  geminiCalls = [];
  r = await classifyExpenseWithGemini('gmail-auto-system', 'ﾕﾆｸﾛ ユニクロ', { source: 'merchant' });
  check('辞書だけで判定（ユニクロ → 衣服）', r.category === '衣服', JSON.stringify(r));
  check('Gemini は呼ばれない', geminiCalls.length === 0);

  console.log('\n# プロンプト');
  const p = buildClassificationPrompt('ｾﾌﾞﾝ-ｲﾚﾌﾞﾝ', ['食費', 'サブスク', 'その他'], 'merchant');
  check('カテゴリの説明を含む', p.includes('- サブスク: 月額'));
  check('分類対象は JSON 文字列で埋め込む', p.includes('"ｾﾌﾞﾝ-ｲﾚﾌﾞﾝ"'));
  check('一覧に無いカテゴリは出さない', !p.includes('- 交通費'));

  console.log(failed ? `\n${failed} failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
