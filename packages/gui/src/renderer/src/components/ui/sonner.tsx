// sonner wrapper (D21). Theme is driven by the same `.dark` class the rest of
// the app keys off — sonner's own `theme` prop just mirrors it.

import { useSyncExternalStore } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

function subscribeToThemeClass(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

function Toaster(props: ToasterProps) {
  const dark = useSyncExternalStore(subscribeToThemeClass, isDark);
  return (
    <Sonner
      theme={dark ? 'dark' : 'light'}
      className="toaster group"
      position="bottom-right"
      {...props}
    />
  );
}

export { Toaster };
