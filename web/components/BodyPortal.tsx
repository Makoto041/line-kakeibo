'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const subscribe = () => () => {};

/**
 * モーダル・シートを body 直下に描く。
 * 祖先に backdrop-filter（.glass）や transform（animate-fade-up）があると、position: fixed の基準が
 * 画面ではなくその祖先の箱になり、カードの中に閉じ込められて下のタブにも隠れるため。
 * ハイドレーション中は何も描かず、それ以降に開いたものは最初の描画からポータルに出す（中の ref・フォーカスが効く）
 */
export default function BodyPortal({ children }: { children: ReactNode }) {
  const client = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
  return client ? createPortal(children, document.body) : null;
}
