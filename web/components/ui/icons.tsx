// lucide に無い形のアイコン（viewBox 24、lucide と同じ線の作り）。
// lucide の House / Users に fill を付けると形が崩れるため、ナビの選択中は塗りの専用形を使う。
import type { SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  size?: number | string;
  strokeWidth?: number | string;
}

/** lucide のアイコンとこのファイルのアイコンのどちらも受け取れる型 */
export type AnyIcon = React.ComponentType<IconProps>;

function Svg({ size = 24, strokeWidth = 2, children, ...rest }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** 角丸の紙＋3 本線（内訳・ナビ「明細」） */
export function DocLines(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4.5" y="2.5" width="15" height="19" rx="3" />
      <path d="M8.5 8h7M8.5 12h7M8.5 16h4.5" />
    </Svg>
  );
}

/** DocLines の選択中（紙を薄く塗り、線を少し太く） */
export function DocLinesFilled({ strokeWidth = 2.2, ...props }: IconProps) {
  return (
    <Svg strokeWidth={strokeWidth} {...props}>
      <rect x="4.5" y="2.5" width="15" height="19" rx="3" fill="currentColor" fillOpacity={0.18} />
      <path d="M8.5 8h7M8.5 12h7M8.5 16h4.5" />
    </Svg>
  );
}

/** 家の塗り（ドア部分を抜く。ナビ「ホーム」の選択中） */
export function HouseFilled(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        d="M12 2.8 3.7 9.6A2 2 0 0 0 3 11.1V19a2 2 0 0 0 2 2h4.5v-5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V21H19a2 2 0 0 0 2-2v-7.9a2 2 0 0 0-.7-1.5Z"
      />
    </Svg>
  );
}

/** 2 人の塗り（後ろの人は少し小さく右上。ナビ「ふたり」の選択中） */
export function UsersFilled(props: IconProps) {
  return (
    <Svg stroke="none" {...props}>
      <circle cx="9" cy="7.5" r="4" fill="currentColor" />
      <path fill="currentColor" d="M2 20v-1a5.5 5.5 0 0 1 5.5-5.5h3A5.5 5.5 0 0 1 16 19v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
      <circle cx="16.5" cy="8" r="3.3" fill="currentColor" />
      <path
        fill="currentColor"
        d="M17.6 13.6A5 5 0 0 1 22 18.6V20a1 1 0 0 1-1 1h-3.6a2.5 2.5 0 0 0 .1-1v-1a6.9 6.9 0 0 0-1.9-4.8 5 5 0 0 1 2-.6Z"
      />
    </Svg>
  );
}

/** UsersFilled と同じ並びの線画（2 人とも丸い頭。ナビ「ふたり」の未選択） */
export function UsersOutline(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="7.5" r="3.6" />
      <path d="M2.8 20.2V19a5 5 0 0 1 5-5h2.4a5 5 0 0 1 5 5v1.2" />
      <circle cx="16.6" cy="8" r="3" />
      <path d="M18 14.1a4.4 4.4 0 0 1 3.9 4.4v1.7" />
    </Svg>
  );
}
