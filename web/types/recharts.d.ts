// Type declarations for Recharts components to fix React 19 compatibility issues
declare module 'recharts' {
  import { ComponentType } from 'react'
  
  export const PieChart: ComponentType<any>
  export const Pie: ComponentType<any>
  export const Cell: ComponentType<any>
  export const ResponsiveContainer: ComponentType<any>
  export const Legend: ComponentType<any>
  export const Tooltip: ComponentType<any>
  export const LineChart: ComponentType<any>
  export const Line: ComponentType<any>
  export const XAxis: ComponentType<any>
  export const YAxis: ComponentType<any>
  export const CartesianGrid: ComponentType<any>
}
