import { Inbox, MessageCircle, Send, ListChecks, Link2 as LinkIcon } from "lucide-react";
import GuestGuide from "../GuestGuide";

/** 一覧が空のとき: ゲスト / 期間内に支出なし / フィルターで 0 件 */
export default function ExpenseEmptyState({ isGuest, hasExpenses }: { isGuest: boolean; hasExpenses: boolean }) {
  return (
    isGuest ? (
      // ゲスト（プレビュー）モード: 使い方ガイドを表示
      <div className="space-y-6">
        <div className="glass rounded-2xl p-6 text-center shadow-glass sm:p-8">
          <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-accent/12 text-accent">
            <Inbox className="h-7 w-7" strokeWidth={1.8} />
          </span>
          <h3 className="text-lg font-semibold text-fg">
            ここにあなたの支出が一覧表示されます
          </h3>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            いまはプレビューモードのためデータがありません。
            <br className="hidden sm:block" />
            LINEボットから届くリンクで開くと、記録した支出の確認・編集ができます。
          </p>
        </div>
        <GuestGuide />
      </div>
    ) : !hasExpenses ? (
      // 初回 / データ無し: 「送る → 見る」導線を主役に
      <div className="glass rounded-2xl p-6 shadow-glass sm:p-8">
        <div className="text-center">
          <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-accent/12 text-accent">
            <MessageCircle className="h-7 w-7" strokeWidth={1.9} />
          </span>
          <h3 className="text-lg font-semibold text-fg">
            この期間に支出はありません
          </h3>
          <p className="mt-1.5 text-sm text-muted">
            上の矢印で他の月を確認できます。LINEに送ると、ここに支出が記録されます。
          </p>
        </div>

        <ol className="mx-auto mt-6 max-w-sm space-y-3">
          {[
            { Icon: Send, title: "LINEで支出を送る", desc: "「500 ランチ」のように金額と内容を送るだけ。" },
            { Icon: ListChecks, title: "「家計簿」と送る", desc: "今月の集計とあなた専用のリンクが届きます。" },
            { Icon: LinkIcon, title: "リンクから確認・編集", desc: "届いたリンクを開くと、ここに支出が表示されます。" },
          ].map(({ Icon, title, desc }, i) => (
            <li key={i} className="flex items-start gap-3 rounded-xl border border-line bg-fg/[0.02] p-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">
                <Icon className="h-4 w-4" strokeWidth={2.1} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-fg">{title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{desc}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    ) : (
      // フィルタで0件
      <div className="glass rounded-2xl p-10 text-center shadow-glass">
        <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-fg/5 text-muted">
          <Inbox className="h-7 w-7" strokeWidth={1.8} />
        </span>
        <h3 className="text-base font-semibold text-fg">
          条件に一致する支出がありません
        </h3>
        <p className="mt-1.5 text-sm text-muted">
          フィルターや期間を変更してみてください。
        </p>
      </div>
    )
  );
}
