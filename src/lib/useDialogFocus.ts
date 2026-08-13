import { type RefObject, useEffect, useRef } from 'react';

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useDialogFocus<T extends HTMLElement>(
  active: boolean,
  onDismiss: () => void,
  canDismiss = true,
  fallbackSelector?: string,
): RefObject<T | null> {
  const dialogRef = useRef<T>(null);
  const dismissRef = useRef(onDismiss);
  const canDismissRef = useRef(canDismiss);

  useEffect(() => { dismissRef.current = onDismiss; }, [onDismiss]);
  useEffect(() => { canDismissRef.current = canDismiss; }, [canDismiss]);

  useEffect(() => {
    if (!active) return;
    if ((!dialogRef.current || !dialogRef.current.isConnected) && fallbackSelector) {
      dialogRef.current = document.querySelector<T>(fallbackSelector);
    }
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => {
      const target = dialogRef.current?.querySelector<HTMLElement>('[autofocus], input:not([disabled]), button:not([disabled])');
      target?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && canDismissRef.current) {
        event.preventDefault();
        dismissRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector));
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [active, fallbackSelector]);

  return dialogRef;
}
