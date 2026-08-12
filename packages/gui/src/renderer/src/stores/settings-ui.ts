// Who may open the settings dialog (v0.2 T4).
//
// The dialog used to own its own `open` flag, which was fine while the gear
// icon in the TopBar was the only way in. The sync popover is a second door —
// "you are not logged in" with no button to fix it is a dead end — and two
// components cannot share a `useState`.

import { create } from 'zustand';

interface SettingsUiState {
  open: boolean;
  openSettings: () => void;
  setOpen: (open: boolean) => void;
}

export const useSettingsUi = create<SettingsUiState>((set) => ({
  open: false,
  openSettings: () => set({ open: true }),
  setOpen: (open) => set({ open }),
}));
