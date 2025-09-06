'use client'

import { useMemo } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts'
import { motion } from 'framer-motion'
import { ExpenseStats } from '../../../lib/hooks'

interface ExpenseRatioChartProps {
  stats?: ExpenseStats | null
}

export default function ExpenseRatioChart({ stats }: ExpenseRatioChartProps) {
  const { data, fixedExpenses, variableExpenses } = useMemo(() => {
    if (!stats?.categoryTotals) {
      return { data: [], fixedExpenses: [], variableExpenses: [] }
    }

    // Calculate fixed vs variable expenses based on categories
    const categories = stats.categoryTotals
    const fixedCategories = ['住宅', '光熱費', '通信費', '保険', '交通費']
    
    const fixedEntries = Object.entries(categories)
      .filter(([category]) => fixedCategories.some(fixed => category.includes(fixed)))
    
    const variableEntries = Object.entries(categories)
      .filter(([category]) => !fixedCategories.some(fixed => category.includes(fixed)))
    
    const fixedTotal = fixedEntries.reduce((sum, [, amount]) => sum + amount, 0)
    const variableTotal = variableEntries.reduce((sum, [, amount]) => sum + amount, 0)
    const total = fixedTotal + variableTotal

    const data = []
    if (fixedTotal > 0) {
      data.push({
        name: '固定費',
        value: fixedTotal,
        percentage: (fixedTotal / total) * 100
      })
    }
    if (variableTotal > 0) {
      data.push({
        name: '変動費',
        value: variableTotal,
        percentage: (variableTotal / total) * 100
      })
    }

    const fixedExpenses = fixedEntries.map(([name, amount]) => ({ name, amount }))
    const variableExpenses = variableEntries.map(([name, amount]) => ({ name, amount }))

    return { data, fixedExpenses, variableExpenses }
  }, [stats])

  const COLORS = {
    '固定費': '#8B5CF6',
    '変動費': '#10B981'
  }

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number; payload: { percentage: number } }> }) => {
    if (active && payload && payload[0]) {
      return (
        <div className="bg-white dark:bg-gray-800 p-3 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700">
          <p className="font-semibold text-foreground">{payload[0].name}</p>
          <p className="text-sm text-muted-foreground">
            ¥{payload[0].value.toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground">
            {payload[0].payload.percentage.toFixed(1)}%
          </p>
        </div>
      )
    }
    return null
  }

  const renderCustomizedLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }: { cx: number; cy: number; midAngle: number; innerRadius: number; outerRadius: number; percent: number }) => {
    const RADIAN = Math.PI / 180
    const radius = innerRadius + (outerRadius - innerRadius) * 0.5
    const x = cx + radius * Math.cos(-midAngle * RADIAN)
    const y = cy + radius * Math.sin(-midAngle * RADIAN)

    return (
      <text 
        x={x} 
        y={y} 
        fill="white" 
        textAnchor={x > cx ? 'start' : 'end'} 
        dominantBaseline="central"
        className="text-lg font-bold"
      >
        {`${(percent * 100).toFixed(1)}%`}
      </text>
    )
  }

  return (
    <div className="space-y-4">
      {data.length === 0 ? (
        <div className="h-[250px] w-full flex items-center justify-center">
          <div className="text-center text-gray-500">
            <div className="text-gray-400 mb-2">
              <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 712-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 712 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <p className="text-sm">支出データがありません</p>
          </div>
        </div>
      ) : (
        <div className="h-[250px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={renderCustomizedLabel}
                outerRadius={90}
                fill="#8884d8"
                dataKey="value"
                animationBegin={0}
                animationDuration={800}
              >
                {data.map((entry, index) => (
                  <Cell 
                    key={`cell-${index}`} 
                    fill={COLORS[entry.name as keyof typeof COLORS]}
                  />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
              <Legend 
                verticalAlign="bottom" 
                height={36}
                formatter={(value: string, entry: { payload: { value: number } }) => (
                  <span className="text-sm text-foreground">
                    {value}: ¥{entry.payload.value.toLocaleString()}
                  </span>
                )}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Breakdown details */}
      {(fixedExpenses.length > 0 || variableExpenses.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {fixedExpenses.length > 0 && (
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              className="space-y-2"
            >
              <h3 className="font-semibold text-sm text-purple-600 dark:text-purple-400">
                固定費の内訳
              </h3>
              {fixedExpenses.map((item, index) => (
                <motion.div
                  key={item.name}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className="flex justify-between items-center p-2 bg-purple-50 dark:bg-purple-900/20 rounded-lg"
                >
                  <span className="text-sm text-foreground">{item.name}</span>
                  <span className="text-sm font-medium text-foreground">
                    ¥{item.amount.toLocaleString()}
                  </span>
                </motion.div>
              ))}
            </motion.div>
          )}

          {variableExpenses.length > 0 && (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="space-y-2"
            >
              <h3 className="font-semibold text-sm text-green-600 dark:text-green-400">
                変動費の内訳
              </h3>
              {variableExpenses.map((item, index) => (
                <motion.div
                  key={item.name}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className="flex justify-between items-center p-2 bg-green-50 dark:bg-green-900/20 rounded-lg"
                >
                  <span className="text-sm text-foreground">{item.name}</span>
                  <span className="text-sm font-medium text-foreground">
                    ¥{item.amount.toLocaleString()}
                  </span>
                </motion.div>
              ))}
            </motion.div>
          )}
        </div>
      )}
    </div>
  )
}
