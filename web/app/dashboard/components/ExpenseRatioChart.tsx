'use client'

import { useState, useEffect } from 'react'
// @ts-ignore - Recharts compatibility with React 19
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts'
import { motion } from 'framer-motion'

interface RatioData {
  name: string
  value: number
  percentage: number
}

export default function ExpenseRatioChart() {
  const [data, setData] = useState<RatioData[]>([])
  const [selectedSegment, setSelectedSegment] = useState<string | null>(null)

  useEffect(() => {
    // TODO: Fetch real data from API
    const fixed = 120000
    const variable = 165000
    const total = fixed + variable

    setData([
      { 
        name: '固定費', 
        value: fixed, 
        percentage: (fixed / total) * 100 
      },
      { 
        name: '変動費', 
        value: variable, 
        percentage: (variable / total) * 100 
      }
    ])
  }, [])

  const COLORS = {
    '固定費': '#8B5CF6',
    '変動費': '#10B981'
  }

  const CustomTooltip = ({ active, payload }: any) => {
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

  const renderCustomizedLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent, name }: any) => {
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

  const fixedExpenses = [
    { name: '家賃', amount: 80000 },
    { name: '保険', amount: 15000 },
    { name: '通信費', amount: 12000 },
    { name: '光熱費', amount: 13000 }
  ]

  const variableExpenses = [
    { name: '食費', amount: 45000 },
    { name: '交通費', amount: 15000 },
    { name: '娯楽費', amount: 30000 },
    { name: '日用品', amount: 18000 },
    { name: 'その他', amount: 57000 }
  ]

  return (
    <div className="space-y-4">
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
              onClick={(data) => setSelectedSegment(data.name)}
            >
              {data.map((entry, index) => (
                <Cell 
                  key={`cell-${index}`} 
                  fill={COLORS[entry.name as keyof typeof COLORS]}
                  style={{
                    filter: selectedSegment && selectedSegment !== entry.name 
                      ? 'opacity(0.5)' 
                      : 'none',
                    cursor: 'pointer'
                  }}
                />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
            <Legend 
              verticalAlign="bottom" 
              height={36}
              formatter={(value: any, entry: any) => (
                <span 
                  className="text-sm text-foreground cursor-pointer hover:underline"
                  onClick={() => setSelectedSegment(value as string)}
                >
                  {value}: ¥{entry.payload.value.toLocaleString()}
                </span>
              )}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Breakdown details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
      </div>
    </div>
  )
}
