import React from 'react';
import { Search, X } from 'lucide-react';

interface LibrarySearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export default function LibrarySearch({ value, onChange, placeholder = 'Search library' }: LibrarySearchProps) {
  return (
    <div className="pointer-events-none fixed left-48 right-0 top-4 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex h-12 w-full max-w-xl items-center gap-3 rounded-lg border border-white/20 bg-black/55 px-4 text-white shadow-lg backdrop-blur-md transition-colors focus-within:border-[var(--loom-accent)]/70">
        <Search className="h-5 w-5 shrink-0 text-white/70" />
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-sm font-medium text-white outline-none placeholder:text-white/45"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="Clear search"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-white/65 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
