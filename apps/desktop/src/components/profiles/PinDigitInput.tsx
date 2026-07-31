import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

type PinDigitInputProps = {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  label?: string;
  className?: string;
  inputClassName?: string;
  length?: number;
  digitLabel?: string;
};

const PIN_LENGTH = 4;

export default function PinDigitInput({
  value,
  onChange,
  autoFocus = false,
  disabled = false,
  label = 'Four-digit PIN',
  className,
  inputClassName,
  length = PIN_LENGTH,
  digitLabel = 'PIN digit',
}: PinDigitInputProps) {
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length }, (_, index) => value[index] || '');

  const replaceDigit = (index: number, input: string) => {
    const digit = input.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[index] = digit;
    if (!digit) next.fill('', index);
    onChange(next.join(''));
    if (digit) inputs.current[index + 1]?.focus();
  };

  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace') {
      event.preventDefault();
      const targetIndex = digits[index] ? index : index - 1;
      if (targetIndex < 0) return;
      const next = [...digits];
      next.fill('', targetIndex);
      onChange(next.join(''));
      inputs.current[targetIndex]?.focus();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      inputs.current[index - 1]?.focus();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      inputs.current[index + 1]?.focus();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (!pasted) return;
    event.preventDefault();
    onChange(pasted);
    inputs.current[Math.min(pasted.length, length) - 1]?.focus();
  };

  return (
    <div role="group" aria-label={label} className={cn('flex gap-2.5', className)}>
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(element) => { inputs.current[index] = element; }}
          value={digit}
          onChange={(event) => replaceDigit(index, event.target.value)}
          onKeyDown={(event) => handleKeyDown(index, event)}
          onPaste={handlePaste}
          onFocus={(event) => event.currentTarget.select()}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          autoFocus={autoFocus && index === 0}
          disabled={disabled}
          aria-label={`${digitLabel} ${index + 1}`}
          className={cn('h-12 w-12 rounded-lg border border-[var(--loom-surface-3)] bg-[var(--loom-surface-2)] text-center text-xl font-semibold text-[var(--loom-text)] outline-none transition-colors focus:border-[var(--loom-accent)] focus:ring-2 focus:ring-[var(--loom-accent)]/25 disabled:opacity-50', inputClassName)}
        />
      ))}
    </div>
  );
}
