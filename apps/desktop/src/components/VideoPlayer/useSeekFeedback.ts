import { useCallback, useEffect, useRef, useState } from 'react';

const SEEK_FEEDBACK_DURATION_MS = 1000;
const SEEK_FEEDBACK_FADE_MS = 150;

type SeekFeedback = {
  scopeKey: string;
  sequence: number;
  direction: -1 | 1;
  seconds: number;
  at: number;
  visible: boolean;
};

export function useSeekFeedback(scopeKey: string) {
  const [feedback, setFeedback] = useState<SeekFeedback | null>(null);
  const latest = useRef<SeekFeedback | null>(null);
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latest.current = null;
    setFeedback(null);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [scopeKey]);

  const showSeekFeedback = useCallback((delta: number) => {
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.05) return;
    const direction = delta < 0 ? -1 : 1;
    const at = performance.now();
    const previous = latest.current;
    const accumulate = previous?.scopeKey === scopeKey && previous.direction === direction
      && at - previous.at < SEEK_FEEDBACK_DURATION_MS;
    const next: SeekFeedback = {
      scopeKey,
      sequence: ++sequence.current,
      direction,
      seconds: Math.round(((accumulate ? previous.seconds : 0) + Math.abs(delta)) * 10) / 10,
      at,
      visible: true,
    };
    latest.current = next;
    setFeedback(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      latest.current = null;
      setFeedback(current => current?.sequence === next.sequence ? { ...current, visible: false } : current);
      timer.current = setTimeout(() => {
        timer.current = null;
        setFeedback(current => current?.sequence === next.sequence ? null : current);
      }, SEEK_FEEDBACK_FADE_MS);
    }, SEEK_FEEDBACK_DURATION_MS);
  }, [scopeKey]);

  return { seekFeedback: feedback?.scopeKey === scopeKey ? feedback : null, showSeekFeedback };
}
