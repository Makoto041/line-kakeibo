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
              <li>レシート画像（OCR処理後に削除）</li>
              <li>Gmail連携時：メール内容（レシート情報の抽出目的のみ）</li>
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
            <h2 className="mb-2 text-base font-semibold text-fg">4. データの保護</h2>
            <p>お客様のデータは、Firebase/Google Cloudの安全なインフラストラクチャで保護されています。</p>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-fg">5. お問い合わせ</h2>
            <p>プライバシーに関するお問い合わせは、LINEボットを通じてご連絡ください。</p>
          </section>

          <p className="mt-8 text-sm text-muted">最終更新日: 2024年1月</p>
        </div>
      </div>
    </div>
  )
}
