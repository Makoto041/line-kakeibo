// メイン画面に出す固定の文字（ここ以外で画面の文言を増やさない）。
// 金額・日付・件数・店名などのデータは含めない。
// 状態によって置き換わる語は、元の語と同じ位置・同じか短い字数にする。

export const T = {
  nav: {
    label: 'メイン',
    home: 'ホーム',
    expenses: '明細',
    futari: 'ふたり',
  },
  home: {
    title: '家計簿',
    household: 'ふたり',
    guest: 'ゲスト',
    remaining: '予算残り',
    over: '予算超過',
    review: '要確認',
    recent: '最近の明細',
  },
  expenses: {
    title: '明細',
    all: 'すべて',
    pending: '要確認',
    advance: '立替',
    counted: '予算に計上済み',
    uncounted: '予算外',
    confirm: '確認',
    empty: '明細なし',
  },
  split: {
    shared: '共同費',
    personal: '除外',
    advance: '立替中',
    settled: '精算済み',
  },
  futari: {
    title: 'ふたり',
    heading: '今月の精算',
    half: '折半',
    advanceOf: 'の立替',
    breakdown: '内訳',
    settle: '精算を記録',
  },
  // アイコンだけのボタンのアクセシブルネーム（画面には出さない）
  aria: {
    settings: '設定',
    search: '検索',
    detail: '詳細',
    edit: '編集',
    prevMonth: '前の月',
    nextMonth: '次の月',
    close: '閉じる',
    back: '戻る',
    retry: '再試行',
  },
  // トーストは 8 字以内の短い語だけ（説明文にしない）
  toast: {
    forbidden: '権限なし',
    network: '通信エラー',
    busy: '混雑中',
    failed: '失敗',
    settled: '精算済み',
  },
} as const;

export type ToastKey = keyof typeof T.toast;
