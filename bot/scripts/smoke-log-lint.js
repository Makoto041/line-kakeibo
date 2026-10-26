/**
 * ログの書き方の ESLint の規則（bot/eslint.config.mjs の no-restricted-syntax。docs/SECURITY_OPERATIONS.md §9）のスモークテスト
 *
 * ESLint の Node API で、違反の例と適合の例の文字列を bot/src のファイルとして検査し、規則が期待どおりに報告するかを確かめる。
 *
 * - 1 つ目の引数のテンプレートリテラル・値を含む + の連結
 * - 例外（e / err / error / 〜Error という名前の変数。isError / hasError は除く）をそのまま渡す（{ error }・[error]・`${error}`・String(error) なども）
 * - .message / .stack を渡す
 * - 適合: errorFields(error)・errorName(parseError)・(error as { status?: unknown })?.status・typeof error など
 *
 * あわせて、実際の bot/src/**\/*.ts を検査し、この規則の報告が 0 件で、規則の重さが error であることを確かめる
 * （CI の lint は `|| echo` で失敗しても落ちないため、規則は npm test のこのスモークで強制する）。
 *
 *   node bot/scripts/smoke-log-lint.js
 */
const path = require('path');
const { ESLint } = require('eslint');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}

const botDir = path.join(__dirname, '..');
const RULE = 'no-restricted-syntax';

// 規則の文言の先頭（どの規則が報告したかを見分ける）
const KIND = {
  template: 'ログの 1 つ目の引数は固定の文字列にする',
  error: '例外をそのままログに渡さない',
  message: '例外の文言（.message）・スタック（.stack）をログに出さない',
};

// 検査する文字列で使う名前（型の検査はしないが、構文として読めるように宣言しておく）
const PRELUDE = [
  'declare const error: any, e: any, err: any, replyError: any, parseError: any, id: any, ok: any;',
  'declare const list: any[], result: any, model: any, text: any, logger: any, status: any, TimeoutError: any;',
  'declare const issueError: any, isError: boolean, hasError: boolean, event: any;',
  'declare function errorFields(x: unknown): any;',
  'declare function errorName(x: unknown): any;',
  'declare function maskId(x: unknown): any;',
  'declare function foo(x: unknown): any;',
  '',
].join('\n');

/** [説明, コード, 期待する報告（KIND のキーの配列。空なら報告なし）] */
const SRC_CASES = [
  // 1 つ目の引数のテンプレートリテラル
  ['1 つ目の引数のテンプレートリテラル', 'console.log(`saved ${id}`);', ['template']],
  ['値を埋め込まないテンプレートリテラルも', 'console.warn(`saved`);', ['template']],
  ['console.info / console.debug も', 'console.info(`a ${id}`); console.debug(`b ${id}`);', ['template', 'template']],
  ['1 つ目の引数の + の連結', "console.log('saved ' + id);", ['template']],
  ['1 つ目の引数の + の連結（関数の結果）', "console.log('saved ' + maskId(id) + ' done');", ['template']],
  ['1 つ目の引数で例外を連結する', "console.error('Save failed: ' + error);", ['template', 'error']],
  // 例外をそのまま渡す
  ['例外をそのまま（error）', "console.error('Save failed', error);", ['error']],
  ['例外をそのまま（e）', "console.warn('Save failed', e);", ['error']],
  ['例外をそのまま（err）', "console.error('Save failed', err);", ['error']],
  ['例外をそのまま（〜Error）', "console.error('Reply failed', replyError);", ['error']],
  ['例外だけを渡す', 'console.error(error);', ['error']],
  ['型の注釈を付けて渡す', "console.error('Save failed', error as Error);", ['error']],
  ['! を付けて渡す', "console.error('Save failed', error!);", ['error']],
  ['展開して渡す', "console.error('Save failed', ...error);", ['error']],
  ['オブジェクトに入れる（{ error }）', "console.error('Save failed', { error });", ['error']],
  ['オブジェクトに入れる（{ cause: err }）', "console.error('Save failed', { user: maskId(id), cause: err });", ['error']],
  ['入れ子のオブジェクトに入れる', "console.error('Save failed', { detail: { e } });", ['error']],
  ['オブジェクトに型の注釈を付けて入れる', "console.error('Save failed', { err: error as Error });", ['error']],
  ['オブジェクトに展開する（{ ...error }）', "console.error('Save failed', { ...error });", ['error']],
  ['配列に入れる', "console.error('Save failed', [error]);", ['error']],
  ['テンプレートリテラルで文字列にする', "console.error('Save failed', { detail: `${error}` });", ['error']],
  ['+ で文字列にする', "console.error('Save failed', 'detail: ' + error);", ['error']],
  ['〜Error（is・has で始まっても次が小文字なら対象）', "console.error('Save failed', { cause: issueError });", ['error']],
  ['String() で文字列にする', "console.error('Save failed', { detail: String(error) });", ['error']],
  ['JSON.stringify() で文字列にする', "console.error('Save failed', JSON.stringify(err));", ['error']],
  ['?? の片側', "console.error('Save failed', { detail: error ?? null });", ['error']],
  ['条件演算子の結果', "console.error('Save failed', { detail: ok ? null : error });", ['error']],
  // .message / .stack
  ['error.message', "console.error('Save failed', error.message);", ['message']],
  ['オブジェクトの中の e.message', "console.error('Save failed', { detail: e.message });", ['message']],
  ['(error as Error).message', "console.error('Save failed', { detail: (error as Error).message });", ['message']],
  ['err?.message', "console.error('Save failed', { detail: err?.message });", ['message']],
  ["err['message']", "console.error('Save failed', { detail: err['message'] });", ['message']],
  ['関数の中の .message（Gemini の §7 の行と同じ形）', "console.error('Gemini request failed', { status, error: String((error as Error)?.message ?? '').slice(0, 300) });", ['message']],
  ['error.stack', "console.error('Save failed', { stack: error.stack });", ['message']],
  // 名前が message のプロパティはすべて対象（LINE の event.message.text は利用者の入力）。種類だけを出したいときはログの外で別名の変数に入れる
  ['LINE の event.message も対象', "console.log('Unhandled', { type: event.message.type });", ['message']],
  ['ログの外で別名の変数に入れれば報告しない', "const messageType = event.message.type; console.log('Unhandled', { type: messageType });", []],
  // 適合（報告しない）
  ['固定文だけ', "console.log('Saved');", []],
  ['固定の文字列どうしの + の連結（長い固定文の折り返し）', "console.warn('No app group is linked. ' + 'Check the members.', { members: list.length });", []],
  ['真偽値の isError / hasError', "console.log('Done', { isError, hasError: hasError });", []],
  ['固定文 + オブジェクト', "console.warn('Gemini response received', { model, chars: text.length });", []],
  ['errorFields(error) を渡す', "console.error('Save failed', errorFields(error));", []],
  ['errorFields(error) を展開する', "console.error('Save failed', { user: maskId(id), ...errorFields(error) });", []],
  ['errorName(parseError) を渡す', "console.error('Not valid JSON', { errorName: errorName(parseError) });", []],
  ['例外のプロパティ（status）を読む', "console.error('Gemini failed', { status: (error as { status?: unknown })?.status });", []],
  ['例外のプロパティを ?? で読む', "console.error('Issue failed', { status: error.response?.status ?? 'no response' });", []],
  ['キーの名前が error（値は固定文）', "console.log('Done', { error: 'none' });", []],
  ['typeof error', "console.log('Done', { type: typeof error });", []],
  ['instanceof', "console.log('Done', { timeout: error instanceof TimeoutError });", []],
  ['&& でプロパティを読む', "console.log('Done', { code: error && error.code });", []],
  ['条件の側に置く', "console.log('Done', { failed: error ? 'yes' : 'no' });", []],
  ['他のオブジェクトの error プロパティ', "console.log('Done', { failed: result.error === undefined });", []],
  ['2 つ目以降の引数のテンプレートリテラル（例外を入れない）', "console.log('Done', `${id}`);", []],
  ['map の引数の e', "console.log('Done', { ids: list.map((e) => e.id) });", []],
  ['console 以外', 'logger.error(`x ${id}`, error, error.message);', []],
  ['ログの外', 'foo(error); const detail = error.message; throw new Error(`x ${detail}`);', []],
];

async function main() {
  const eslint = new ESLint({ cwd: botDir });
  /** 文字列を bot の指定のパスのファイルとして検査し、[規則の報告, 構文の誤り] を返す */
  const lint = async (code, relPath) => {
    const [result] = await eslint.lintText(code, { filePath: path.join(botDir, relPath) });
    return [result.messages.filter((m) => m.ruleId === RULE), result.messages.filter((m) => m.fatal)];
  };
  const kindOf = (message) => Object.keys(KIND).find((key) => message.message.startsWith(KIND[key])) ?? message.message;

  console.log('\n[bot/src の TypeScript]');
  for (const [name, code, expected] of SRC_CASES) {
    const [reports, fatal] = await lint(PRELUDE + code, 'src/__smoke_log_lint__.ts');
    const kinds = reports.map(kindOf);
    check(
      `${name}: ${expected.length ? expected.join(', ') : '報告なし'}`,
      fatal.length === 0 && JSON.stringify(kinds) === JSON.stringify(expected),
      fatal.length ? fatal[0].message : kinds
    );
  }

  console.log('\n[例外の行（eslint-disable-next-line）]');
  {
    const body = [
      "console.error('Gemini request failed', {",
      '  status,',
      '  // eslint-disable-next-line no-restricted-syntax -- 例外として API のエラー文の先頭 300 文字を出す',
      "  error: String((error as Error)?.message ?? '').slice(0, 300),",
      '});',
      '',
    ].join('\n');
    const [withDirective] = await lint(PRELUDE + body, 'src/__smoke_log_lint__.ts');
    check('次の行の 1 か所だけを許す（報告なし）', withDirective.length === 0, withDirective.map(kindOf));
    const [withoutDirective] = await lint(PRELUDE + body.replace(/^.*eslint-disable-next-line.*\n/m, ''), 'src/__smoke_log_lint__.ts');
    check('コメントが無ければ報告する', JSON.stringify(withoutDirective.map(kindOf)) === JSON.stringify(['message']), withoutDirective.map(kindOf));
  }

  console.log('\n[対象の範囲]');
  {
    const code = "console.log(`  ok   ${name}`, error, error.message);\n";
    const [scripts] = await lint(`const name = 'x'; const error = new Error('x');\n${code}`, 'scripts/__smoke_log_lint__.js');
    check('bot/scripts の JavaScript は対象外（出力は手元の端末だけ）', scripts.length === 0, scripts.map(kindOf));
  }

  // CI の lint は `|| echo` で失敗しても落ちないので、規則はここ（npm test）で強制する
  console.log('\n[実際の bot/src]');
  {
    const config = await eslint.calculateConfigForFile(path.join(botDir, 'src/index.ts'));
    const setting = config.rules?.[RULE];
    const severity = Array.isArray(setting) ? setting[0] : setting;
    check('規則の重さが error', severity === 2 || severity === 'error', { severity });
    check('規則のセレクタが読み込まれている', Array.isArray(setting) && setting.length > 1, { entries: Array.isArray(setting) ? setting.length - 1 : 0 });

    const results = await eslint.lintFiles(['src/**/*.ts']);
    // 規則の報告・構文の誤り・使われていない eslint-disable（例外の行が規則に当たらなくなった）を集める
    const problems = results.flatMap((result) =>
      result.messages
        .filter((m) => m.ruleId === RULE || m.fatal || (m.ruleId === null && m.message.includes(RULE)))
        .map((m) => `${path.relative(botDir, result.filePath)}:${m.line} ${m.message.slice(0, 60)}`)
    );
    check(
      `bot/src の ${results.length} ファイルに報告が無い（geminiClient.ts の §7 の行は eslint-disable-next-line で除く）`,
      results.length > 0 && problems.length === 0,
      problems
    );
  }

  console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
