/**
 * Format seconds into HH:MM:SS or MM:SS string.
 *
 * Args:
 *   seconds (number): Time in seconds.
 *
 * Returns:
 *   string: Formatted time string.
 */
export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Get appropriate step size based on duration.
 * Shorter videos get finer control, longer videos get coarser steps.
 *
 * Args:
 *   duration (number): Total duration in seconds.
 *
 * Returns:
 *   number: Step size in seconds.
 */
export function getStepSize(duration: number): number {
  if (duration <= 60) return 0.5;
  if (duration <= 300) return 1;
  if (duration <= 1800) return 5;
  return 10;
}
