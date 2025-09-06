'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface Alert {
  id: string
  type: 'warning' | 'danger' | 'info' | 'success'
  title: string
  message: string
  icon: string
}

export default function BudgetAlert() {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set())

  useEffect(() => {
    // TODO: Fetch real alerts from API
    // Mock data for now
    const mockAlerts: Alert[] = [
      {
        id: '1',
        type: 'warning',
        title: '予算超過警告',
        message: '今月の支出が予算の82%に達しました。残り¥63,000です。',
        icon: '⚠️'
      },
      {
        id: '2',
        type: 'info',
        title: '節約のヒント',
        message: '先月と比べて食費が15%増加しています。外食を控えることで月¥10,000節約できます。',
        icon: '💡'
      },
      {
        id: '3',
        type: 'success',
        title: '良い調子です！',
        message: '今月の光熱費は前月比で10%削減できました。',
        icon: '✨'
      }
    ]

    // Filter out dismissed alerts
    const activeAlerts = mockAlerts.filter(alert => !dismissedAlerts.has(alert.id))
    setAlerts(activeAlerts)
  }, [dismissedAlerts])

  const dismissAlert = (id: string) => {
    setDismissedAlerts(prev => new Set(prev).add(id))
  }

  const getAlertStyles = (type: Alert['type']) => {
    switch (type) {
      case 'warning':
        return 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200'
      case 'danger':
        return 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'
      case 'info':
        return 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200'
      case 'success':
        return 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-800 dark:text-green-200'
    }
  }

  if (alerts.length === 0) {
    return null
  }

  return (
    <div className="space-y-3">
      <AnimatePresence mode="popLayout">
        {alerts.map((alert) => (
          <motion.div
            key={alert.id}
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 100, scale: 0.95 }}
            transition={{ duration: 0.3 }}
            className={`
              relative p-4 rounded-xl border-2 backdrop-blur-sm
              ${getAlertStyles(alert.type)}
            `}
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl flex-shrink-0">{alert.icon}</span>
              <div className="flex-1">
                <h3 className="font-semibold text-sm mb-1">{alert.title}</h3>
                <p className="text-sm opacity-90">{alert.message}</p>
              </div>
              <button
                onClick={() => dismissAlert(alert.id)}
                className="flex-shrink-0 p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                aria-label="Dismiss alert"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
