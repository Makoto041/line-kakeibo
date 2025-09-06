'use client'

import { motion } from 'framer-motion'
import { useState, useEffect } from 'react'

interface SummaryData {
  totalExpense: number
  fixedExpense: number
  variableExpense: number
  monthlyChange: number
  budgetUsage: number
}

export default function SummaryCards() {
  const [data, setData] = useState<SummaryData>({
    totalExpense: 0,
    fixedExpense: 0,
    variableExpense: 0,
    monthlyChange: 0,
    budgetUsage: 0
  })

  useEffect(() => {
    // TODO: Fetch real data from API
    // Mock data for now
    setData({
      totalExpense: 285000,
      fixedExpense: 120000,
      variableExpense: 165000,
      monthlyChange: -5.2,
      budgetUsage: 82
    })
  }, [])

  const cards = [
    {
      title: '今月の支出合計',
      value: `¥${data.totalExpense.toLocaleString()}`,
      icon: '💴',
      bgColor: 'bg-gradient-to-br from-blue-500 to-blue-600',
      change: data.monthlyChange,
      changeType: data.monthlyChange < 0 ? 'decrease' : 'increase'
    },
    {
      title: '固定費',
      value: `¥${data.fixedExpense.toLocaleString()}`,
      icon: '🏠',
      bgColor: 'bg-gradient-to-br from-purple-500 to-purple-600',
      percentage: ((data.fixedExpense / data.totalExpense) * 100).toFixed(1)
    },
    {
      title: '変動費',
      value: `¥${data.variableExpense.toLocaleString()}`,
      icon: '🛒',
      bgColor: 'bg-gradient-to-br from-green-500 to-green-600',
      percentage: ((data.variableExpense / data.totalExpense) * 100).toFixed(1)
    },
    {
      title: '予算使用率',
      value: `${data.budgetUsage}%`,
      icon: '📊',
      bgColor: data.budgetUsage > 80 
        ? 'bg-gradient-to-br from-red-500 to-red-600' 
        : 'bg-gradient-to-br from-amber-500 to-amber-600',
      progressBar: true,
      progress: data.budgetUsage
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

            {card.change !== undefined && (
              <div className="flex items-center gap-1">
                <span className={card.changeType === 'decrease' ? 'text-green-200' : 'text-red-200'}>
                  {card.changeType === 'decrease' ? '↓' : '↑'}
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

            {card.progressBar && (
              <div className="mt-3">
                <div className="w-full bg-white/20 rounded-full h-2">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${card.progress}%` }}
                    transition={{ duration: 1, delay: 0.5 }}
                    className="bg-white rounded-full h-2"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Decorative element */}
          <div className="absolute -bottom-6 -right-6 w-24 h-24 bg-white/10 rounded-full blur-xl" />
        </motion.div>
      ))}
    </div>
  )
}
