'use client';

import React from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Pie, Bar, Line } from 'react-chartjs-2';
import dayjs from 'dayjs';

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Title,
  Tooltip,
  Legend
);

interface CategoryPieChartProps {
  data: Record<string, number>;
}

export function CategoryPieChart({ data }: CategoryPieChartProps) {
  const chartData = {
    labels: Object.keys(data),
    datasets: [
      {
        data: Object.values(data),
        backgroundColor: [
          '#FF6384',
          '#36A2EB',
          '#FFCE56',
          '#4BC0C0',
          '#9966FF',
          '#FF9F40',
          '#FF6384',
          '#C9CBCF'
        ],
        borderWidth: 2
      }
    ]
  };

  const options = {
    responsive: true,
    plugins: {
      legend: {
        position: 'bottom' as const,
      },
      title: {
        display: true,
        text: 'カテゴリ別支出'
      }
    }
  };

  return <Pie data={chartData} options={options} />;
}

interface MonthlyBarChartProps {
  data: Record<string, number>;
  label?: string;
}

export function MonthlyBarChart({ data, label = '支出額' }: MonthlyBarChartProps) {
  const chartData = {
    labels: Object.keys(data),
    datasets: [
      {
        label,
        data: Object.values(data),
        backgroundColor: 'rgba(54, 162, 235, 0.5)',
        borderColor: 'rgba(54, 162, 235, 1)',
        borderWidth: 2
      }
    ]
  };

  const options = {
    responsive: true,
    plugins: {
      legend: {
        position: 'top' as const,
      },
      title: {
        display: true,
        text: '月間支出推移'
      }
    },
    scales: {
      y: {
        beginAtZero: true,
        ticks: {
          callback: function(value: string | number) {
            return '¥' + Number(value).toLocaleString();
          }
        }
      }
    }
  };

  return <Bar data={chartData} options={options} />;
}

interface DailyLineChartProps {
  data: Record<string, number>;
  startDate: string;
  endDate: string;
  mode: 'monthly' | 'custom';
}

export function DailyLineChart({ data, startDate, endDate, mode }: DailyLineChartProps) {
  let chartData;
  
  // Generate all days in the range - using dayjs for better timezone handling
  const start = dayjs(startDate);
  const end = dayjs(endDate);
  const allDays: string[] = [];
  
  let current = start;
  while (current.isBefore(end) || current.isSame(end, 'day')) {
    allDays.push(current.format('YYYY-MM-DD'));
    current = current.add(1, 'day');
  }

  if (mode === 'monthly') {
    // For monthly mode, show day numbers (1, 2, 3...)
    chartData = {
      labels: allDays.map(date => {
        const day = date.split('-')[2];
        return day + '日';
      }),
      datasets: [
        {
          label: '日別支出',
          data: allDays.map(date => data[date] || 0),
          borderColor: 'rgb(75, 192, 192)',
          backgroundColor: 'rgba(75, 192, 192, 0.2)',
          tension: 0.1
        }
      ]
    };
  } else {
    // For custom range, show month/day format
    chartData = {
      labels: allDays.map(date => {
        const parts = date.split('-');
        return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
      }),
      datasets: [
        {
          label: '日別支出',
          data: allDays.map(date => data[date] || 0),
          borderColor: 'rgb(75, 192, 192)',
          backgroundColor: 'rgba(75, 192, 192, 0.2)',
          tension: 0.1
        }
      ]
    };
  }

  const options = {
    responsive: true,
    plugins: {
      legend: {
        position: 'top' as const,
      },
      title: {
        display: true,
        text: '日別支出推移'
      }
    },
    scales: {
      y: {
        beginAtZero: true,
        ticks: {
          callback: function(value: string | number) {
            return '¥' + Number(value).toLocaleString();
          }
        }
      }
    }
  };

  return <Line data={chartData} options={options} />;
}