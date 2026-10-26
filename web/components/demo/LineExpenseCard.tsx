// デモの確認カード。bot の Flex Message（bot/src/line/flexMessage.ts の buildExpenseCard）を、同じ骨格・色・文言で描く。
// 文言・色・アイコンは lib/demo/demoLine.ts から取り、ここには書かない（bot のソースとの一致は __tests__/demoCard.test.mjs）。
// 大きさは Flex の値を px にしたもの（文字 xs 13 / sm 14 / md 16 / lg 19 / xl 22、余白 sm 4 / md 8 / lg 12 / xl 16、幅は kilo の 260）。
// 見出しのアイコン（Flex の icon・size md）は、この表の文字の md（16）ではなく 19px で描く（見出しの文字と並べた見た目で決めた値）。
// LINE と同じく、カードはテーマに関係なく白で描く。押して動くのは OK（呼び出し側が会話に足す）と「家計簿一覧を見る」（デモの支出一覧）だけで、
// ほかのボタン（修正・レシート添付・行末のボタン）は見た目だけ。
import Link from 'next/link';
import {
  ACTION_TONE_COLORS,
  CARD_COLORS,
  CARD_FOOTER,
  CARD_TEXT,
  ICON_BUTTON_PALETTE,
  iconSrc,
  type CardFooterButton,
  type CardSettingRow,
  type DemoExpenseCard,
} from '../../lib/demo/demoLine';
import { sceneOf } from '../../lib/demo/demoScenes';

const LIST_SCENE = sceneOf('expenses');
const INERT_TITLE = 'デモでは押せません';

export function CardIcon({ iconKey, size }: { iconKey: string; size: number }) {
  // 同じ origin の小さな PNG（web/public/icons）。next/image の最適化は要らない
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={iconSrc(iconKey)} alt="" width={size} height={size} className="shrink-0" style={{ width: size, height: size }} />;
}

function SettingRow({ row }: { row: CardSettingRow }) {
  const tone = ACTION_TONE_COLORS[row.buttonTone];
  return (
    <div className="mt-2 flex items-center">
      <CardIcon iconKey={row.iconKey} size={20} />
      <p className="ml-2 min-w-0 flex-1 break-words text-[14px] leading-snug">
        <span style={{ color: CARD_COLORS.label }}>
          {row.label}
          {CARD_TEXT.labelSuffix}
        </span>
        <span className="font-bold" style={{ color: CARD_COLORS.value }}>
          {row.value}
        </span>
        {row.subValue && (
          <>
            <span style={{ color: CARD_COLORS.subSeparator }}>{CARD_TEXT.subSeparator}</span>
            <span className="font-bold" style={{ color: CARD_COLORS.value }}>
              {row.subValue}
            </span>
          </>
        )}
        {row.note && (
          <span className="text-[13px]" style={{ color: CARD_COLORS.note }}>
            {row.note}
          </span>
        )}
      </p>
      <span
        title={INERT_TITLE}
        className="ml-1 shrink-0 cursor-default rounded-lg px-4 py-3 text-center text-[14px] font-bold leading-none"
        style={{ backgroundColor: tone.background, color: tone.text }}
      >
        {row.buttonLabel}
      </span>
    </div>
  );
}

function FooterButton({
  button,
  onClick,
  disabled,
  toList,
}: {
  button: CardFooterButton;
  onClick?: () => void;
  disabled?: boolean;
  /** デモの支出一覧へのリンクにする（家計簿一覧を見る） */
  toList?: boolean;
}) {
  const palette = ICON_BUTTON_PALETTE[button.variant];
  const className = 'flex min-w-0 flex-1 items-center justify-center rounded-lg p-2 text-[14px] font-bold leading-tight';
  const style = { backgroundColor: palette.bg, color: palette.text };
  const content = (
    <>
      <CardIcon iconKey={button.iconKey} size={18} />
      <span className="ml-1">{button.label}</span>
    </>
  );
  if (toList) {
    return (
      <Link href={LIST_SCENE.href} className={`${className} transition-opacity hover:opacity-80`} style={style}>
        {content}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`${className} transition-opacity hover:opacity-80 disabled:cursor-default disabled:opacity-60`}
        style={style}
      >
        {content}
      </button>
    );
  }
  return (
    <span title={INERT_TITLE} className={`${className} cursor-default`} style={style}>
      {content}
    </span>
  );
}

export default function LineExpenseCard({
  card,
  onOk,
  okDisabled,
}: {
  card: DemoExpenseCard;
  /** OK を押したとき（無ければ見た目だけ） */
  onOk?: () => void;
  okDisabled?: boolean;
}) {
  return (
    <div className="w-[260px] max-w-full overflow-hidden rounded-[18px] bg-white text-left text-[#111111] shadow-sm">
      <div className="flex items-center gap-1 p-3" style={{ backgroundColor: CARD_COLORS.headerBg }}>
        <CardIcon iconKey={card.headerIconKey} size={19} />
        <span className="text-[16px] font-bold" style={{ color: CARD_COLORS.headerText }}>
          {card.headerText}
        </span>
      </div>
      <div className="p-3">
        <p className="break-words text-[19px] font-bold leading-snug">{card.title}</p>
        <div className="mt-1 flex items-baseline">
          <span className="flex-1 text-[22px] font-bold tabular-nums" style={{ color: CARD_COLORS.amount }}>
            {card.amountText}
          </span>
          <span className="text-[14px] tabular-nums" style={{ color: CARD_COLORS.date }}>
            {card.dateText}
          </span>
        </div>
        <div className="mt-3">
          <hr className="border-0 border-t border-[#dddddd]" />
          <p className="mt-3 text-[13px]" style={{ color: CARD_COLORS.sectionTitle }}>
            {CARD_TEXT.sectionTitle}
          </p>
          {card.settings.map((row) => (
            <SettingRow key={row.label} row={row} />
          ))}
        </div>
      </div>
      <div className="space-y-1 p-2">
        <div className="flex gap-1">
          <FooterButton button={CARD_FOOTER.ok} onClick={onOk} disabled={okDisabled} />
          <FooterButton button={CARD_FOOTER.edit} />
        </div>
        <FooterButton button={CARD_FOOTER.attach} />
        <FooterButton button={CARD_FOOTER.list} toList />
      </div>
    </div>
  );
}
