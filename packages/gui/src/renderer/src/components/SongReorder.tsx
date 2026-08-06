// Drag-to-reorder (T7, M5-16). Every dnd-kit import in the renderer lives
// here, so the table stays a table and the library choice stays swappable.
//
// Three things are load-bearing, all three measured in the spike (plan §8.4):
//
//   - `attributes: {role: 'row'}`. The default is `role="button"`, which on a
//     <tr> silently destroys the table's row semantics — for screen readers
//     and for every `getAllByRole('row')` in the test suite.
//   - an 8px activation distance, so a click still selects and a double-click
//     still plays. Below that the row would start dragging on a sloppy click.
//   - the wrappers are pass-throughs when reordering is off, which is the case
//     for the virtual `all`, for search results, and for any sort other than
//     the manual one (R24). Nothing to drag means no drag context at all.

import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  type PointerSensorOptions,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { PropsWithChildren } from 'react';
import { type RowDragHandle, SongRow, type SongRowProps } from './SongRow.js';

/**
 * Where a press must NOT start a drag. The row is draggable as a whole, which
 * means a pointerdown inside the inline-edit input or on an action button also
 * arms the sensor — and then selecting text in a song name by dragging would
 * reorder the playlist. dnd-kit's own activator only checks the mouse button,
 * so the exclusion has to be added here.
 */
const NO_DRAG_SELECTOR = 'input, textarea, select, button, a, [contenteditable="true"]';

/** Exported for its own test: this predicate is the whole guard. */
export function canStartDragFrom(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return target.closest(NO_DRAG_SELECTOR) === null;
}

class RowPointerSensor extends PointerSensor {
  static override activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: (
        { nativeEvent: event }: React.PointerEvent,
        { onActivation }: PointerSensorOptions,
      ): boolean => {
        if (!event.isPrimary || event.button !== 0) return false;
        if (!canStartDragFrom(event.target)) return false;
        onActivation?.({ event });
        return true;
      },
    },
  ];
}

interface ReorderAreaProps extends PropsWithChildren {
  enabled: boolean;
  /** Called with the dragged song and the one whose place it was dropped on. */
  onDrop: (movedId: string, targetId: string) => void;
}

/** Wraps the whole table — never the <tbody>, which may only contain rows. */
export function ReorderArea({ enabled, onDrop, children }: ReorderAreaProps): React.JSX.Element {
  const sensors = useSensors(
    useSensor(RowPointerSensor, { activationConstraint: { distance: 8 } }),
  );

  if (!enabled) return <>{children}</>;

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    onDrop(String(active.id), String(over.id));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      // A row can only go up or down, and only within its own list.
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      {children}
    </DndContext>
  );
}

interface SortableRowsProps extends PropsWithChildren {
  enabled: boolean;
  ids: readonly string[];
}

/** Sits inside the <tbody>; renders no DOM of its own. */
export function SortableRows({ enabled, ids, children }: SortableRowsProps): React.JSX.Element {
  if (!enabled) return <>{children}</>;
  return (
    <SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
      {children}
    </SortableContext>
  );
}

interface SortableSongRowProps extends SongRowProps {
  /** True while a reorder request is in flight — one drag at a time (M5-16). */
  disabled: boolean;
}

export function SortableSongRow({
  disabled,
  ...rowProps
}: SortableSongRowProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rowProps.song.id,
    disabled,
    attributes: { role: 'row' },
  });

  const drag: RowDragHandle = {
    ref: setNodeRef,
    style: { transform: CSS.Transform.toString(transform), transition },
    // The one cast in the file: dnd-kit types its listener map as
    // `Record<string, Function>`, which no JSX spread will accept.
    handleProps: { ...attributes, ...listeners } as React.HTMLAttributes<HTMLTableRowElement>,
    isDragging,
  };

  return <SongRow {...rowProps} drag={drag} />;
}
