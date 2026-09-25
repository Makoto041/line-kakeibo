'use client'

export default function TermsOfService() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 md:py-8">
      <div className="glass rounded-2xl p-6 shadow-glass md:p-8">
        <h1 className="mb-6 text-2xl font-bold text-fg">利用規約</h1>

        <div className="space-y-6 text-muted">
          <section>
            <h2 className="mb-2 text-base font-semibold text-fg">1. サービスの概要</h2>
            <p>LINE家計簿（以下「本サービス」）は、LINEを通じて家計管理を行うためのサービスです。</p>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-fg">2. 利用条件</h2>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>本サービスの利用にはLINEアカウントが必要です</li>
              <li>利用者は正確な情報を提供する責任があります</li>
              <li>不正利用や悪用は禁止されています</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-fg">3. 免責事項</h2>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>本サービスは「現状有姿」で提供されます</li>
              <li>データの損失や誤りについて責任を負いません</li>
              <li>サービスの中断や終了について事前通知なく行う場合があります</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-fg">4. 知的財産権</h2>
            <p>本サービスに関するすべての知的財産権は、サービス提供者に帰属します。</p>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-fg">5. 規約の変更</h2>
            <p>本規約は予告なく変更される場合があります。変更後も本サービスを利用された場合、変更に同意したものとみなします。</p>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-fg">6. 準拠法</h2>
            <p>本規約は日本法に準拠します。</p>
          </section>

          <p className="mt-8 text-sm text-muted">最終更新日: 2024年1月</p>
        </div>
      </div>
    </div>
  )
}
