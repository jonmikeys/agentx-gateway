import * as React from "react";

type AutoFocusHandler = (event: Event) => void;

/**
 * Returns focus to the element that opened a modal once it closes.
 *
 * Radix only restores focus to a `Trigger`. The CRM opens most dialogs from controlled state
 * (a table row button sets `open`), so there is no trigger and focus would fall back to `<body>`,
 * which breaks keyboard navigation. Spread the result on the Radix `Content` element. A caller
 * can still `preventDefault()` in its own `onCloseAutoFocus` to focus something else.
 */
export function useReturnFocus({
  onOpenAutoFocus,
  onCloseAutoFocus,
}: {
  onOpenAutoFocus?: AutoFocusHandler;
  onCloseAutoFocus?: AutoFocusHandler;
} = {}) {
  const opener = React.useRef<HTMLElement | null>(null);

  return {
    onOpenAutoFocus: (event: Event) => {
      opener.current = document.activeElement as HTMLElement | null;
      onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus: (event: Event) => {
      onCloseAutoFocus?.(event);
      const target = opener.current;
      if (event.defaultPrevented || !target?.isConnected || target === document.body) return;
      event.preventDefault();
      target.focus();
    },
  };
}
