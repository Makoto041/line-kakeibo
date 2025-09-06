'use client'

import { motion } from 'framer-motion'
import { ExpenseStats } from '../../../lib/hooks'

interface SummaryCardsProps {
  stats?: ExpenseStats | null
}

export default function SummaryCards({ stats }: SummaryCardsProps) {
  // Default values when no stats available
  const totalExpense = stats?.totalAmount || 0
  const expenseCount = stats?.expenseCount || 0
  
  // Calculate fixed vs variable costs based on categories
  // This is a simplified calculation - you might want to improve this logic
  const categories = stats?.categoryTotals || {}
  const fixedCategories = ['住宅', '光熱費', '通信費', '保険', '交通費']
  const fixedExpense = Object.entries(categories)
    .filter(([category]) => fixedCategories.some(fixed => category.includes(fixed)))
    .reduce((sum, [, amount]) => sum + amount, 0)
  const variableExpense = totalExpense - fixedExpense

  const cards = [
    {
      title: '今月の支出合計',
      value: `¥${totalExpense.toLocaleString()}`,
      icon: '💴',
      bgColor: 'bg-gradient-to-br from-blue-500 to-blue-600',
      // TODO: Calculate actual monthly change when we have historical data
      change: 0,
      changeType: 'same' as const
    },
    {
      title: '固定費',
      value: `¥${fixedExpense.toLocaleString()}`,
      icon: '🏠',
      bgColor: 'bg-gradient-to-br from-purple-500 to-purple-600',
      percentage: totalExpense > 0 ? ((fixedExpense / totalExpense) * 100).toFixed(1) : '0'
    },
    {
      title: '変動費',
      value: `¥${variableExpense.toLocaleString()}`,
      icon: '🛒',
      bgColor: 'bg-gradient-to-br from-green-500 to-green-600',
      percentage: totalExpense > 0 ? ((variableExpense / totalExpense) * 100).toFixed(1) : '0'
    },
    {
      title: '支出回数',
      value: `${expenseCount}回`,
      icon: '📊',
      bgColor: 'bg-gradient-to-br from-amber-500 to-amber-600',
      // Average amount per expense
      subValue: totalExpense > 0 && expenseCount > 0 
        ? `平均 ¥${Math.round(totalExpense / expenseCount).toLocaleString()}`
        : '平均 ¥0'
    }
  ]

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card, index) => (
        <motion.div
          key={card.title}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: index * 0.1 }}
          whileHover={{ scale: 1.02 }}
          className="relative overflow-hidden rounded-xl shadow-lg"
        >
          <div className={`${card.bgColor} p-6 text-white`}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-white/80 text-sm font-medium">{card.title}</p>
                <p className="text-2xl lg:text-3xl font-bold mt-1">{card.value}</p>
              </div>
              <span className="text-3xl">{card.icon}</span>
            </div>

            {card.change !== undefined && card.change !== 0 && (
              <div className="flex items-center gap-1">
                <span className={
                  card.changeType === 'decrease' ? 'text-green-200' : 
                  card.changeType === 'increase' ? 'text-red-200' :
                  'text-white/60'
                }>
                  {card.changeType === 'decrease' ? '↓' : 
                   card.changeType === 'increase' ? '↑' : '→'}
                </span>
                <span className="text-sm text-white/80">
                  前月比 {Math.abs(card.change)}%
                </span>
              </div>
            )}

            {card.percentage && (
              <p className="text-sm text-white/80">
                全体の {card.percentage}%
              </p>
            )}

            {card.subValue && (
              <p className="text-sm text-white/80">
                {card.subValue}
              </p>
            )}
          </div>

          {/* Decorative element */}
          <div className="absolute -bottom-6 -right-6 w-24 h-24 bg-white/10 rounded-full blur-xl" />
        </motion.div>
      ))}
    </div>
  )
}
