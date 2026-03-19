'use client';

import { Info } from 'lucide-react';

export default function InfoTip({ text }: { text: string }) {
  return (
    <span className="relative group/tip cursor-help ml-1 inline-flex">
      <Info className="w-3 h-3 text-text-muted/30 group-hover/tip:text-text-muted/60 transition-colors" />
      <span className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 p-2.5 rounded-md bg-[#1a1a2e] border border-border/40 text-[10px] font-mono text-text-secondary leading-relaxed invisible group-hover/tip:visible pointer-events-none shadow-xl whitespace-normal">
        {text}
      </span>
    </span>
  );
}
