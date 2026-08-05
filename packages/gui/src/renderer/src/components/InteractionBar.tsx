// Second bar of the Go layout. T5 fills the left side with the download input
// and its batch entry point; T3 lands the sort control that shares it.

import { SortControl } from './SortControl.js';

export function InteractionBar(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b px-3 py-2">
      <div className="flex-1" />
      <SortControl />
    </div>
  );
}
