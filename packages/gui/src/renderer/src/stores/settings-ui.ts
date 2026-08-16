// Who may open the settings dialog, and where it lands (v0.2 T4, §7 F4).
//
// The dialog used to own its own `open` flag, which was fine while the gear
// icon in the TopBar was the only way in. The sync popover is a second door —
// "you are not logged in" with no button to fix it is a dead end — and two
// components cannot share a `useState`.
//
// Which door it was matters too: "去登录…" opened the dialog on the GENERAL
// tab, so the fix for the thing the badge was complaining about was one more
// click away, unexplained. So the opener names the tab, and the dialog's Tabs
// are controlled — a `defaultValue` is read once per mount and the dialog
// stays mounted.

import { create } from 'zustand';

/** The dialog's tabs, as their `TabsTrigger` values. */
export type SettingsTab = 'general' | 'sync';

interface SettingsUiState {
  open: boolean;
  tab: SettingsTab;
  openSettings: (tab?: SettingsTab) => void;
  setOpen: (open: boolean) => void;
  setTab: (tab: SettingsTab) => void;
}

export const useSettingsUi = create<SettingsUiState>((set) => ({
  open: false,
  tab: 'general',
  openSettings: (tab = 'general') => set({ open: true, tab }),
  setOpen: (open) => set({ open }),
  setTab: (tab) => set({ tab }),
}));
