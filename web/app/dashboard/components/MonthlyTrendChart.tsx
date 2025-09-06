'use client'

import { useState, useEffect } from 'react'
// @ts-ignore - Recharts compatibility with React 19
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts'

interface MonthlyData {
  month: string
  fixed: number
  variable: number
  total: number
}

export default function MonthlyTrendChart() {
  const [data, setData] = useState<MonthlyData[]>([])

  useEffect(() => {
    // TODO: Fetch real data from API
    // Mock data for now
    setData([
      { month: '1月', fixed: 120000, variable: 145000, total: 265000 },
      { month: '2月', fixed: 120000, variable: 138000, total: 258000 },
      { month: '3月', fixed: 120000, variable: 152000, total: 272000 },
      { month: '4月', fixed: 120000, variable: 160000, total: 280000 },
      { month: '5月', fixed: 120000, variable: 155000, total: 275000 },
      { month: '6月', fixed: 120000, variable: 165000, total: 285000 }
    ])
  }, [])

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700">
          <p className="font-semibold text-foreground mb-2">{label}</p>
          {payload.map((entry: any, index: number) => (
            <p key={index} className="text-sm" style={{ color: entry.color }}>
              {entry.name}: ¥{entry.value.toLocaleString()}
            </p>
          ))}
        </div>
      )
    }
    return null
  }

  const formatYAxis = (value: number) => {
    return `¥${(value / 1000).toFixed(0)}k`
  }

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
        >
          <CartesianGrid 
            strokeDasharray="3 3" 
            className="stroke-gray-200 dark:stroke-gray-700"
          />
          <XAxis 
            dataKey="month" 
            className="text-xs"
            tick={{ fill: 'currentColor' }}
          />
          <YAxis 
            tickFormatter={formatYAxis}
            className="text-xs"
            tick={{ fill: 'currentColor' }}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend 
            wrapperStyle={{ paddingTop: '20px' }}
            formatter={(value: any) => (
              <span className="text-sm text-foreground">{value}</span>
            )}
          />
          <Line
            type="monotone"
            dataKey="total"
            stroke="#3B82F6"
            strokeWidth={3}
            name="合計"
            dot={{ fill: '#3B82F6', r: 4 }}
            activeDot={{ r: 6 }}
            animationDuration={1000}
          />
          <Line
            type="monotone"
            dataKey="fixed"
            stroke="#8B5CF6"
            strokeWidth={2}
            name="固定費"
            dot={{ fill: '#8B5CF6', r: 3 }}
            activeDot={{ r: 5 }}
            animationDuration={1200}
          />
          <Line
            type="monotone"
            dataKey="variable"
            stroke="#10B981"
            strokeWidth={2}
            name="変動費"
            dot={{ fill: '#10B981', r: 3 }}
            activeDot={{ r: 5 }}
            animationDuration={1400}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
