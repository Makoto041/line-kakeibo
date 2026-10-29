/**
 * /auth/line のレート制限のスモークテスト
 *
 * 既定のキー（req.ip）は Cloud Run では前段のアドレスにまとまり、1 人の連打で全員が 429 になる。
 * 接続元の IP（X-Forwarded-For の末尾。clientIp.ts の clientIpKey）で数えることを、本物のルーターで確かめる。
 * LINE への問い合わせまで進めないよう、idToken の無い要求（400）で数える。
 *   node bot/scripts/smoke-auth-rate-limit.js
 */
const http = require('http');
const express = require('express');
const { authRouter } = require('../dist/auth/lineAuth');

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (xff) => {
    const res = await fetch(`${base}/auth/line`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(xff ? { 'X-Forwarded-For': xff } : {}) },
      body: '{}',
    });
    await res.text();
    return res.status;
  };

  try {
    console.log('\n# 接続元の IP ごとに 1 分 60 回');
    const first = [];
    for (let i = 0; i < 60; i++) first.push(await post('198.51.100.1'));
    check('60 回までは通る（idToken が無いので 400）', first.every((s) => s === 400), [...new Set(first)]);
    check('61 回目は 429', (await post('198.51.100.1')) === 429);
    check('別の接続元は数えない（1 人の連打で全員が止まらない）', (await post('198.51.100.2')) === 400);
    check('X-Forwarded-For の前の値（クライアントが送れる値）を変えても、末尾が同じなら同じ枠', (await post('1.2.3.4, 198.51.100.1')) === 429);
    check('末尾が別なら別の枠（前の値を詐称しても枠は増えない・減らない）', (await post('198.51.100.1, 198.51.100.3')) === 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
