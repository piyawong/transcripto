import { formatTime } from './utils';
import type { TimeDisplayProps } from './types';

/**
 * Small label with formatted time value.
 *
 * Args:
 *   label (string): Label text (e.g. "Start", "End").
 *   seconds (number): Time in seconds.
 */
export function TimeDisplay({ label, seconds }: TimeDisplayProps) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">
        {label}
      </span>
      <span className="text-sm font-mono font-semibold text-gray-700">
        {formatTime(seconds)}
      </span>
    </div>
  );
}
