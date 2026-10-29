import { isIP } from 'node:net';
import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

/**
 * 認証前のレート制限のキー（接続元の IP）
 *
 * `trust proxy` は `/auth/line` の挙動を変えないため設定しておらず、Cloud Run では req.ip が前段の
 * アドレスにまとまる（そのままだと 1 人の連打でインスタンス上の全員が 429 になる）。Google のフロント
 * エンドは X-Forwarded-For の末尾に接続元の IP を足すので、末尾の値をキーにする（クライアントが送った値は
 * その前に並ぶだけなので、末尾は詐称できない）。末尾が IP として読めなければ req.ip。IPv6 は
 * ipKeyGenerator で /56 にまとめる。前段がさらに増えて末尾が共通のアドレスになった場合は、従来どおり
 * インスタンス全体の上限として働く（そのため上限は大きめのまま）。
 */
export function clientIpKey(req: Pick<Request, 'headers' | 'ip'>): string {
  const header = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(header) ? header.join(',') : header ?? '').split(',');
  const last = hops[hops.length - 1].trim();
  const ip = last && isIP(last) ? last : req.ip;
  return ipKeyGenerator(ip || 'unknown');
}
