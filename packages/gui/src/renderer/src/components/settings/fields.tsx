// The settings page's two layout primitives (split out of SettingsDialog in
// v0.2 T4 — both tabs use them, and the sync tab is a separate file).

import { Label } from '../ui/label.js';

export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="space-y-3 border-border border-t pt-4 first:border-t-0 first:pt-0">
      <div>
        <h3 className="font-medium text-sm">{title}</h3>
        {hint !== undefined && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  /** One line under the control, for a setting whose scope is not obvious. */
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-center gap-3">
      <Label htmlFor={htmlFor} className="justify-end text-muted-foreground">
        {label}
      </Label>
      <div className="space-y-1">
        {children}
        {hint !== undefined && <p className="text-muted-foreground text-xs">{hint}</p>}
        {error !== undefined && <p className="text-destructive text-xs">{error}</p>}
      </div>
    </div>
  );
}

const MIB = 1024 * 1024;

export function formatSize(bytes: number): string {
  if (bytes >= MIB * 1024) return `${(bytes / (MIB * 1024)).toFixed(2)} GB`;
  return `${(bytes / MIB).toFixed(1)} MB`;
}
