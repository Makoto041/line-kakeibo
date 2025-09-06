'use client'

import { ExpenseStats } from '../../../lib/hooks'

interface MonthlyTrendChartProps {
  stats?: ExpenseStats | null
}

export default function MonthlyTrendChart({ stats }: MonthlyTrendChartProps) {
  // For now, just return a placeholder since we don't have historical trend data
  // Suppress unused vars warning since this is a placeholder implementation
  void stats;
  return (
    <div className="h-[300px] w-full flex items-center justify-center">
      <div className="text-center text-gray-500">
        <div className="text-gray-400 mb-2">
          <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 712 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 712-2h2a2 2 0 712 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </div>
        <p className="text-sm">月次推移データは開発中です</p>
      </div>
    </div>
  )
}
