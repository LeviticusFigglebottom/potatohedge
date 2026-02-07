import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(n: number, decimals: number = 2): string {
  if (Math.abs(n) >= 1e12) return (n / 1e12).toFixed(1) + 'T';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(decimals);
}

export function formatCurrency(n: number, decimals: number = 2): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatPercent(n: number, decimals: number = 2): string {
  return (n >= 0 ? '+' : '') + n.toFixed(decimals) + '%';
}

export function formatDelta(n: number): string {
  return n.toFixed(3);
}

export function formatIV(n: number): string {
  return (n * 100).toFixed(1) + '%';
}

export function colorForChange(change: number): string {
  if (change > 0) return 'text-accent-green';
  if (change < 0) return 'text-accent-red';
  return 'text-text-secondary';
}

export function bgForChange(change: number): string {
  if (change > 0) return 'bg-accent-green/10';
  if (change < 0) return 'bg-accent-red/10';
  return 'bg-bg-tertiary';
}

export function debounce<T extends (...args: unknown[]) => unknown>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: unknown[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}
