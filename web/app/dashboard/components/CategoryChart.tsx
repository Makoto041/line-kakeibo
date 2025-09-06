'use client'

import { useState, useEffect } from 'react'
// @ts-expect-error - Recharts compatibility with React 19
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts'

interface CategoryData {
  name: string
  value: number
  color: string
}

export default function CategoryChart() {
  const [data, setData] = useState<CategoryData[]>([])

  useEffect(() => {
    // TODO: Fetch real data from API
    // Mock data for now
    setData([
      { name: '食費', value: 45000, color: '#3B82F6' },
      { name: '交通費', value: 15000, color: '#10B981' },
      { name: '光熱費', value: 25000, color: '#F59E0B' },
      { name: '通信費', value: 12000, color: '#EF4444' },
      { name: '娯楽費', value: 30000, color: '#8B5CF6' },
      { name: '日用品', value: 18000, color: '#EC4899' },
      { name: 'その他', value: 20000, color: '#6B7280' }
    ])
  }, [])

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number }> }) => {
    if (active && payload && payload[0]) {
      return (
        <div className="bg-white dark:bg-gray-800 p-3 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700">
          <p className="font-semibold text-foreground">{payload[0].name}</p>
          <p className="text-sm text-muted-foreground">
            ¥{payload[0].value.toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground">
            {((payload[0].value / data.reduce((a, b) => a + b.value, 0)) * 100).toFixed(1)}%
          </p>
        </div>
      )
    }
    return null
  }

  const CustomLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }: { cx: number; cy: number; midAngle: number; innerRadius: number; outerRadius: number; percent: number }) => {
    const RADIAN = Math.PI / 180
    const radius = innerRadius + (outerRadius - innerRadius) * 0.5
    const x = cx + radius * Math.cos(-midAngle * RADIAN)
    const y = cy + radius * Math.sin(-midAngle * RADIAN)

    if (percent < 0.05) return null // Don't show label for small slices

    return (
      <text
        x={x}
        y={y}
        fill="white"
        textAnchor={x > cx ? 'start' : 'end'}
        dominantBaseline="central"
        className="text-xs font-semibold"
      >
        {`${(percent * 100).toFixed(0)}%`}
      </text>
    )
  }

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            labelLine={false}
            label={CustomLabel}
            outerRadius={100}
            fill="#8884d8"
            dataKey="value"
            animationBegin={0}
            animationDuration={800}
          >
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip />} />
          {/* @ts-expect-error - React 19 compatibility issue with Recharts */}
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
  )
}
