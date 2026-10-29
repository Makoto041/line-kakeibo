// デモ（/demo）の LINE の場面（会話・確認カード・カード利用の取込）の文言・色・文例。発表後に lib/demo ごと消す。
// 確認カードは bot の Flex Message（bot/src/line/flexMessage.ts の buildExpenseCard）を手で写したもの。
// 文言・色・アイコン・判定元の表示名・ボタンは bot のソースと同じにし、__tests__/demoCard.test.mjs で bot のソースと突き合わせる
// （bot のモジュールは web から import できないので、テストがソースを文字列として読む）。レイアウトのずれは検出できない。
// 画面（components/demo/LineChat・LineExpenseCard・GmailFlow）は、ここにある文字列と色だけを描く。
// node --test から直接読めるよう、何も import しない。

/** 判定元の表示名（bot: CATEGORY_ORIGIN_LABELS） */
export const CATEGORY_ORIGIN_LABELS = {
  rule: 'ルール',
  dictionary: '辞書',
  jev: 'Jev',
  gemini: 'Gemini',
  specified: '指定',
  default: '既定',
  unclassified: '未判定',
} as const;

export type DemoCategoryOrigin = keyof typeof CATEGORY_ORIGIN_LABELS;

/** カテゴリの後ろに付ける「（辞書）」（bot: categoryOriginNote） */
export function categoryOriginNote(origin: DemoCategoryOrigin): string {
  return `（${CATEGORY_ORIGIN_LABELS[origin]}）`;
}

/** カードの色（bot の Flex Message に書いてある値。テーマに合わせて変えない） */
export const CARD_COLORS = {
  headerBg: '#ECFDF5',
  headerText: '#10B981',
  amount: '#0F172A',
  date: '#64748B',
  sectionTitle: '#64748B',
  label: '#64748B',
  value: '#0F172A',
  subSeparator: '#94A3B8',
  note: '#64748B',
} as const;

export type ActionTone = 'primary' | 'danger';

/** 「現在の設定」の行末ボタンの色（bot: ACTION_TONE_COLORS） */
export const ACTION_TONE_COLORS: Record<ActionTone, { background: string; text: string }> = {
  primary: { background: '#EFF6FF', text: '#2563EB' },
  danger: { background: '#FEF2F2', text: '#DC2626' },
};

export type IconButtonVariant = 'primary' | 'secondary';

/** 下のボタン（アイコン付き）の色（bot: iconActionButton の palette） */
export const ICON_BUTTON_PALETTE: Record<IconButtonVariant, { bg: string; text: string }> = {
  primary: { bg: '#D1FAE5', text: '#065F46' },
  secondary: { bg: '#F1F5F9', text: '#334155' },
};

/** カードの文言（bot の buildExpenseCard・deriveExpenseSettings・buildCurrentSettingsSection・postback.ts と同じ） */
export const CARD_TEXT = {
  sectionTitle: '現在の設定',
  /** 「支出区分：」のラベルの後ろ（全角のコロン） */
  labelSuffix: '：',
  subSeparator: ' › ',
  labels: { split: '支出区分', payer: '支払った人', advance: '立替', category: 'カテゴリ' },
  /** LINE の手入力（未確認） */
  pendingSplit: '共同費（未確認）',
  sharedSplit: '共同費',
  splitButton: '除外',
  payerButton: '自分が払った',
  noAdvance: 'なし（折半）',
  advanceButton: '自分が立替',
  /** カテゴリの行のボタン（bot は buttonLabel を渡さず、既定の「変更」） */
  categoryButton: '変更',
  /** カード利用（Gmail 取込）の支払った人 */
  cardPayer: 'カード',
  /** OK を押したときに LINE に出る発言（postback の displayText） */
  okDisplayText: 'この内容で確定',
} as const;

/** カードの種類ごとの見出し（アイコンは web/public/icons/<key>.png） */
export const CARD_HEADERS = {
  text: { iconKey: 'receipt', text: '支出を登録しました' },
  gmail: { iconKey: 'credit-card', text: 'カード利用を記録' },
  /** OK を押したあとに返るカード（postback.ts の replyUpdatedCard） */
  confirmed: { iconKey: 'check', text: '登録を確定しました' },
} as const;

export interface CardFooterButton {
  iconKey: string;
  label: string;
  variant: IconButtonVariant;
}

/** 下のボタン（1 段目に OK・修正、2 段目にレシート添付、3 段目に家計簿一覧を見る） */
export const CARD_FOOTER = {
  ok: { iconKey: 'check', label: 'OK', variant: 'primary' },
  edit: { iconKey: 'pencil', label: '修正', variant: 'secondary' },
  attach: { iconKey: 'paperclip', label: 'レシート添付', variant: 'secondary' },
  list: { iconKey: 'external-link', label: '家計簿一覧を見る', variant: 'secondary' },
} as const satisfies Record<string, CardFooterButton>;

/** 「現在の設定」の行頭のアイコン */
export const SETTING_ICONS = {
  /** 共同費（未確認を含む） */
  split: 'users',
  payerMember: 'wallet',
  payerCard: 'credit-card',
  advance: 'hand-coins',
} as const;

/** カテゴリのアイコン（bot: CATEGORY_ICON_KEY のうち、デモに出るカテゴリだけ） */
export const CATEGORY_ICON_KEYS: Readonly<Record<string, string>> = {
  食費: 'cat-food',
  娯楽: 'cat-fun',
  住居費: 'cat-housing',
  光熱費: 'cat-utility',
  通信費: 'cat-comm',
  サブスク: 'cat-subscription',
  日用品: 'cat-daily',
  交通費: 'cat-transport',
  衣服: 'cat-clothes',
  美容: 'cat-beauty',
  その他: 'cat-other',
};

export function categoryIconKey(category: string): string {
  return Object.prototype.hasOwnProperty.call(CATEGORY_ICON_KEYS, category) ? CATEGORY_ICON_KEYS[category] : 'cat-other';
}

/** 同じ origin の web/public/icons の PNG（bot が LINE に送るアイコンと同じ絵） */
export function iconSrc(key: string): string {
  return `/icons/${key}.png`;
}

/** 金額（bot: `¥${amount.toLocaleString()}`。bot の実行環境の書式と同じ 3 桁区切り） */
export function cardAmount(amount: number): string {
  return `¥${amount.toLocaleString('en-US')}`;
}

/** トークの日付の区切り（YYYY-MM-DD → 10/24(土)） */
export function talkDateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${m}/${d}(${'日月火水木金土'[new Date(y, m - 1, d).getDay()]})`;
}

/** YYYY-MM-DD → M/D（bot: formatCardDate） */
export function cardDate(date: string): string {
  const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date);
  return matched ? `${Number(matched[2])}/${Number(matched[3])}` : date;
}

// ---- カードの中身 ---------------------------------------------------------------

export interface CardSettingRow {
  iconKey: string;
  label: string;
  value: string;
  /** 「食費 › 昼ご飯」の中項目 */
  subValue?: string;
  /** 判定元「（辞書）」 */
  note?: string;
  buttonLabel: string;
  buttonTone: ActionTone;
}

export interface DemoExpenseCard {
  headerIconKey: string;
  headerText: string;
  title: string;
  amountText: string;
  dateText: string;
  settings: CardSettingRow[];
}

interface CardInput {
  header: { iconKey: string; text: string };
  title: string;
  amount: number;
  date: string;
  /** 未確認（LINE の手入力）か、共同費（確定・カード取込） */
  split: 'pending' | 'shared';
  payer: string;
  category: string;
  subCategory: string;
  origin?: DemoCategoryOrigin;
}

function buildCard(input: CardInput): DemoExpenseCard {
  const { labels } = CARD_TEXT;
  return {
    headerIconKey: input.header.iconKey,
    headerText: input.header.text,
    title: input.title,
    amountText: cardAmount(input.amount),
    dateText: cardDate(input.date),
    settings: [
      {
        iconKey: SETTING_ICONS.split,
        label: labels.split,
        value: input.split === 'pending' ? CARD_TEXT.pendingSplit : CARD_TEXT.sharedSplit,
        buttonLabel: CARD_TEXT.splitButton,
        buttonTone: 'danger',
      },
      {
        iconKey: input.payer === CARD_TEXT.cardPayer ? SETTING_ICONS.payerCard : SETTING_ICONS.payerMember,
        label: labels.payer,
        value: input.payer,
        buttonLabel: CARD_TEXT.payerButton,
        buttonTone: 'primary',
      },
      {
        iconKey: SETTING_ICONS.advance,
        label: labels.advance,
        value: CARD_TEXT.noAdvance,
        buttonLabel: CARD_TEXT.advanceButton,
        buttonTone: 'primary',
      },
      {
        iconKey: categoryIconKey(input.category),
        label: labels.category,
        value: input.category,
        subValue: input.subCategory,
        note: input.origin ? categoryOriginNote(input.origin) : undefined,
        buttonLabel: CARD_TEXT.categoryButton,
        buttonTone: 'primary',
      },
    ],
  };
}

// ---- LINE の会話（手入力） ---------------------------------------------------------

/**
 * 送れる文例。自由入力はさせない（bot の判定をデモで再現できないため）。
 * どれも、大項目は bot のキーワード辞書（geminiCategoryClassifier.ts の FAST_KEYWORD_MAP）で、
 * 中項目は中項目の辞書（subCategoryRules.ts）で決まる語だけ（__tests__/demoCard.test.mjs で bot のソースから確かめる）。
 * テキストの入力には時刻のルールを当てない（時刻のルールはカード利用の店名だけ）。
 */
export interface DemoChatExample {
  key: string;
  /** 送る文（「ランチ 850」） */
  text: string;
  description: string;
  amount: number;
  category: string;
  subCategory: string;
}

export const DEMO_CHAT_EXAMPLES: readonly DemoChatExample[] = [
  { key: 'lunch', text: 'ランチ 850', description: 'ランチ', amount: 850, category: '食費', subCategory: '昼ご飯' },
  { key: 'cafe', text: 'カフェ 520', description: 'カフェ', amount: 520, category: '食費', subCategory: 'カフェ' },
  { key: 'party', text: '飲み会 4000', description: '飲み会', amount: 4000, category: '食費', subCategory: '外食' },
  { key: 'movie', text: '映画 1800', description: '映画', amount: 1800, category: '娯楽', subCategory: '映画' },
  { key: 'karaoke', text: 'カラオケ 1200', description: 'カラオケ', amount: 1200, category: '娯楽', subCategory: '音楽・ライブ' },
];

/** 会話で送る人（世帯のメンバー。lib/demo/demoData.ts の Aさん） */
export const DEMO_CHAT_SENDER = 'Aさん';
/** LINE グループの名前（架空）と人数（ふたり＋家計簿の LINE 公式アカウント） */
export const DEMO_LINE_GROUP = { name: 'ふたりの家計簿', memberCount: 3 } as const;
/** 家計簿の LINE 公式アカウントの表示名 */
export const DEMO_BOT_NAME = 'ぶちこむ家計簿';

/** 文例を送ったときに返るカード（bot: buildTextExpenseFlexMessage。判定元は辞書） */
export function textExpenseCard(example: DemoChatExample, date: string): DemoExpenseCard {
  return buildCard({
    header: CARD_HEADERS.text,
    title: example.description,
    amount: example.amount,
    date,
    split: 'pending',
    payer: DEMO_CHAT_SENDER,
    category: example.category,
    subCategory: example.subCategory,
    origin: 'dictionary',
  });
}

/** OK を押したあとに返るカード（bot: replyUpdatedCard → buildExpenseCardFromRecord。共同費になり、判定元は出ない） */
export function confirmedTextCard(example: DemoChatExample, date: string): DemoExpenseCard {
  return buildCard({
    header: CARD_HEADERS.confirmed,
    title: example.description,
    amount: example.amount,
    date,
    split: 'shared',
    payer: DEMO_CHAT_SENDER,
    category: example.category,
    subCategory: example.subCategory,
  });
}

// ---- カード利用の取込（Gmail） --------------------------------------------------------

/**
 * カード会社から届く利用のお知らせ（架空）。送信元は .example のドメイン、店は架空の「サンプル食堂」、カードの名前は出さない。
 * 本文の書き方は bot のメールの読み取り（bot/src/gmail/parser.ts）が読める形（ご利用日時・ご利用店名・ご利用金額）。
 */
export const DEMO_CARD_EMAIL = {
  from: 'notice@card.example',
  subject: 'カードご利用のお知らせ',
  receivedAt: '10/24 12:19',
  lead: 'カードのご利用がありました。',
  /** JST */
  usedAt: { date: '2026/10/24', time: '12:18' },
  merchant: 'サンプル食堂',
  amount: 1280,
} as const;

/** メールの本文の行（ご利用日時・ご利用店名・ご利用金額） */
export function cardEmailLines(): string[] {
  const e = DEMO_CARD_EMAIL;
  return [`ご利用日時：${e.usedAt.date} ${e.usedAt.time}`, `ご利用店名：${e.merchant}`, `ご利用金額：${e.amount.toLocaleString('en-US')}円`];
}

/** YYYY/MM/DD → YYYY-MM-DD（支出の date） */
export function cardEmailDate(): string {
  return DEMO_CARD_EMAIL.usedAt.date.replace(/\//g, '-');
}

/**
 * 取込で決まる分類。大項目は店名をモデルで判定する（キャッシュ → Jev → Gemini → 辞書 の順。デモでは Jev で決まった体）。
 * 中項目は中項目の辞書で「食堂」が飲食店に当たり、メールに時刻があるので、JST の時刻で朝ご飯・昼ご飯・夜ご飯にする
 */
export const DEMO_CARD_RESULT = {
  category: '食費',
  origin: 'jev',
  /** 中項目の辞書で店名に当たる語（飲食店のグループ） */
  matchedKeyword: '食堂',
  subCategory: '昼ご飯',
} as const satisfies { category: string; origin: DemoCategoryOrigin; matchedKeyword: string; subCategory: string };

/** 店名の大項目を決める順（bot: classifyExpense の source='merchant'） */
export const MERCHANT_CLASSIFY_ORDER = ['キャッシュ', 'Jev', 'Gemini', '辞書'] as const;

/** 時刻のルール（bot: mealOfJst。JST の時。夜は 17:00〜翌 04:59） */
export const MEAL_BANDS = [
  { sub: '朝ご飯', label: '朝', range: '05:00〜10:59', fromHour: 5, toHour: 10 },
  { sub: '昼ご飯', label: '昼', range: '11:00〜16:59', fromHour: 11, toHour: 16 },
  { sub: '夜ご飯', label: '夜', range: '17:00〜04:59', fromHour: 17, toHour: 4 },
] as const;

/** 時（0〜23）の食事（bot: mealOfJst と同じ境目） */
export function mealOfHour(hour: number): (typeof MEAL_BANDS)[number]['sub'] {
  if (hour >= 5 && hour <= 10) return '朝ご飯';
  if (hour >= 11 && hour <= 16) return '昼ご飯';
  return '夜ご飯';
}

/** グループに届くカード（bot: buildCardUsageFlexMessage。支払った人は「カード」、共同費で確定して入る） */
export function cardUsageCard(): DemoExpenseCard {
  return buildCard({
    header: CARD_HEADERS.gmail,
    title: DEMO_CARD_EMAIL.merchant,
    amount: DEMO_CARD_EMAIL.amount,
    date: cardEmailDate(),
    split: 'shared',
    payer: CARD_TEXT.cardPayer,
    category: DEMO_CARD_RESULT.category,
    subCategory: DEMO_CARD_RESULT.subCategory,
    origin: DEMO_CARD_RESULT.origin,
  });
}
