import { useEffect, useRef, type RefObject } from 'react';
import { AccessibilityInfo, findNodeHandle } from 'react-native';

type MobileFocusableRef = RefObject<{ focus?: () => void } | null>;

type MobileFocusTarget = {
  node: number;
  invoker?: unknown;
  ref?: MobileFocusableRef;
};

type MobileModalLayer = {
  id: string;
  priority: number;
  sequence: number;
  onBack: () => void;
  restoreFocusTarget?: MobileFocusTarget;
};

const layers: MobileModalLayer[] = [];
let sequence = 0;
let pendingFocusTarget: MobileFocusTarget | null = null;

export function captureMobileFocus(event: { currentTarget?: unknown }): void {
  if (event.currentTarget === undefined) return;
  const node = findNodeHandle(event.currentTarget as Parameters<typeof findNodeHandle>[0]);
  if (node !== null) pendingFocusTarget = { invoker: event.currentTarget, node };
}

export function clearCapturedMobileFocus(): void {
  pendingFocusTarget = null;
}

function takeMobileFocusTarget(): MobileFocusTarget | undefined {
  const target = pendingFocusTarget || undefined;
  pendingFocusTarget = null;
  return target;
}

function focusTargetFromRef(ref?: MobileFocusableRef): MobileFocusTarget | undefined {
  if (!ref?.current) return undefined;
  const node = findNodeHandle(ref.current as Parameters<typeof findNodeHandle>[0]);
  return node === null ? undefined : { node, ref };
}

function restoreMobileFocus(target?: MobileFocusTarget): void {
  const focusable = target?.ref?.current;
  focusable?.focus?.();
  const node = focusable
    ? findNodeHandle(focusable as Parameters<typeof findNodeHandle>[0])
    : target?.invoker !== undefined
      ? findNodeHandle(target.invoker as Parameters<typeof findNodeHandle>[0])
      : target?.ref
        ? null
        : target?.node ?? null;
  if (node === null) return;
  setTimeout(() => {
    try {
      AccessibilityInfo.setAccessibilityFocus(node);
    } catch {
      // The native focus target may disappear during a transition.
    }
  }, 0);
}

export function topMobileModalLayer(): MobileModalLayer | null {
  return layers.reduce<MobileModalLayer | null>((top, layer) => {
    if (!top || layer.priority > top.priority || (layer.priority === top.priority && layer.sequence > top.sequence)) {
      return layer;
    }
    return top;
  }, null);
}

/**
 * React Native dispatches hardware Back to subscriptions rather than visual
 * z-order. This explicit stack keeps nested surfaces deterministic.
 */
export function useMobileModalLayer({
  open = true,
  onBack,
  priority = 10,
  restoreFocusRef,
}: {
  open?: boolean;
  onBack: () => void;
  priority?: number;
  restoreFocusRef?: MobileFocusableRef;
}): void {
  const idRef = useRef<string | null>(null);
  if (!idRef.current) idRef.current = `mobile-modal-${++sequence}`;
  const callbackRef = useRef(onBack);
  const wasOpenRef = useRef(false);
  const restoreTargetRef = useRef<MobileFocusTarget | undefined>(undefined);
  if (open && !wasOpenRef.current) restoreTargetRef.current = focusTargetFromRef(restoreFocusRef);
  wasOpenRef.current = open;
  callbackRef.current = onBack;

  useEffect(() => {
    if (!open || !idRef.current) return undefined;
    const layer: MobileModalLayer = {
      id: idRef.current,
      priority,
      sequence: ++sequence,
      onBack: () => callbackRef.current(),
      restoreFocusTarget: restoreTargetRef.current || takeMobileFocusTarget(),
    };
    layers.push(layer);
    return () => {
      const index = layers.findIndex((candidate) => candidate.id === layer.id);
      if (index >= 0) layers.splice(index, 1);
      restoreMobileFocus(layer.restoreFocusTarget);
    };
  }, [open, priority]);
}
