'use client'

import { ExpenseStats } from '../../../lib/hooks'

interface BudgetAlertProps {
  stats?: ExpenseStats | null
}

export default function BudgetAlert({ stats }: BudgetAlertProps) {
  // For now, just return a placeholder since we don't have budget data in our stats
  // Suppress unused vars warning since this is a placeholder implementation
  void stats;
  return null;
}
