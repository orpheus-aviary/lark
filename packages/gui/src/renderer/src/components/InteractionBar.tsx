// Second bar of the Go layout: the download input on the left, the sort
// control on the right — and beneath them one full-width row carrying the
// download status on the left and the batch actions on the right.
//
// The sort control is handed to DownloadBar as trailing content rather than
// being a sibling: as a sibling it sat beside BOTH rows, which stopped the
// status row short of the real right edge and left the batch buttons floating
// in the middle of the bar.

import { DownloadBar } from './DownloadBar.js';
import { SortControl } from './SortControl.js';

export function InteractionBar(): React.JSX.Element {
  return (
    <div className="border-b px-3 py-2">
      <DownloadBar trailing={<SortControl />} />
    </div>
  );
}
