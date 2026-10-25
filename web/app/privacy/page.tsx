'use client'

export default function PrivacyPolicy() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 md:py-8">
      <div className="glass rounded-2xl p-6 shadow-glass md:p-8">
        <h1 className="mb-6 text-2xl font-bold text-fg">プライバシーポリシー</h1>

        <div className="space-y-6 text-muted">
          <section>
            <h2 className="mb-2 text-base font-semibold text-fg">1. 収集する情報</h2>
            <p>本アプリケーション（LINE家計簿）は、以下の情報を収集します：</p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>LINEアカウント情報（ユーザーID、表示名）</li>
              <li>家計簿データ（支出金額、カテゴリ、日付、メモ）</li>
              <li>レシート画像（Webで支出に添付した場合）</li>
              <li>Gmail連携時：メール内容（カード利用通知の店名・金額・利用日時の抽出目的のみ）</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-fg">2. 情報の利用目的</h2>
            <p>収集した情報は以下の目的で利用します：</p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>家計簿機能の提供</li>
              <li>支出の分析・レポート作成</li>
              <li>サービスの改善</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-fg">3. 情報の共有</h2>
            <p>お客様の個人情報を第三者に販売、貸与することはありません。ただし、以下の場合を除きます：</p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>お客様の同意がある場合</li>
              <li>法令に基づく場合</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-fg">4. 外部のサービスへの送信</h2>
            <p>支出のカテゴリを自動で判定するため、以下の情報を外部のAIサービス（Google Gemini API、およびTypeSafe AI）に送信します：</p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>LINEで送られた支出の内容の一部（先頭100文字まで）</li>
              <li>カード利用通知メールに記載された店名</li>
              <li>カテゴリ名（追加したカテゴリ名を含む）</li>
            </ul>
            <p className="mt-2">また、「要望」「改善」「不具合」「フィードバック」で始まるメッセージは、本文の全文をGoogle Gemini APIに送信して内容を整理し、本文と整理した内容を公開のGitHubリポジトリのIssueとして掲載します。</p>
            <p className="mt-2">LINEのユーザーID・表示名は送信しません。送信先での取り扱いは、各社の規約に従います。</p>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-fg">5. データの保護</h2>
            <p>本アプリケーションが保存するデータは、Firebase/Google Cloudの安全なインフラストラクチャで保護されています（前項の外部のサービスへの送信を除く）。</p>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-fg">6. お問い合わせ</h2>
            <p>プライバシーに関するお問い合わせは、LINEボットを通じてご連絡ください。</p>
          </section>

          <p className="mt-8 text-sm text-muted">最終更新日: 2026年10月25日</p>
        </div>
      </div>
    </div>
  )
}
