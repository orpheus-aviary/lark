// Second bar of the Go layout: the download input on the left, the sort
// control on the right.

import { DownloadBar } from './DownloadBar.js';
import { SortControl } from './SortControl.js';

export function InteractionBar(): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 border-b px-3 py-2">
      <DownloadBar />
      <SortControl />
    </div>
  );
}
