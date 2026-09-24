import { createLucideIcon } from 'lucide-react';

// lucide に同じ形が無いアイコン（lucide と同じ線の作り・viewBox 24）。

/** 電車の正面（角丸の車体・行き先表示・窓の帯・前照灯・脚）。交通費の行アイコン・カテゴリアイコン */
export const TrainBoxy = createLucideIcon('train-boxy', [
  ['rect', { x: '5', y: '2.5', width: '14', height: '16.5', rx: '3', key: 'body' }],
  ['path', { d: 'M10 5.5h4', key: 'sign' }],
  ['path', { d: 'M5 11h14', key: 'band' }],
  ['path', { d: 'M9 15h.01', key: 'light-l' }],
  ['path', { d: 'M15 15h.01', key: 'light-r' }],
  ['path', { d: 'm8 19-2 3', key: 'leg-l' }],
  ['path', { d: 'm16 19 2 3', key: 'leg-r' }],
]);
