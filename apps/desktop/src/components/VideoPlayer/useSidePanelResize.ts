import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from 'react';
import { clampSidePanelWidth } from './helpers';

type SetPanelWidth = Dispatch<SetStateAction<number>>;

export function useSidePanelResize() {
  const stopResizeRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    stopResizeRef.current?.();
  }, []);

  return useCallback((
    event: ReactMouseEvent<HTMLDivElement>,
    currentWidth: number,
    setWidth: SetPanelWidth,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    stopResizeRef.current?.();

    const startX = event.clientX;
    const startWidth = currentWidth;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      setWidth(clampSidePanelWidth(startWidth + startX - moveEvent.clientX));
    };

    const stopResize = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', stopResize);
      if (stopResizeRef.current === stopResize) stopResizeRef.current = null;
    };

    stopResizeRef.current = stopResize;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', stopResize);
  }, []);
}
