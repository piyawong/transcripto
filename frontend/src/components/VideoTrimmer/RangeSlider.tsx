'use client';

import { useCallback, useRef } from 'react';
import type { RangeSliderProps } from './types';

const MIN_GAP_SECONDS = 1;

/**
 * Dual-handle range slider for selecting start/end time.
 * Uses two overlapping <input type="range"> with a purple highlight track.
 *
 * Args:
 *   min (number): Minimum value.
 *   max (number): Maximum value.
 *   startValue (number): Current start value.
 *   endValue (number): Current end value.
 *   step (number): Step increment.
 *   onStartChange (function): Callback when start changes.
 *   onEndChange (function): Callback when end changes.
 */
export function RangeSlider({
  min,
  max,
  startValue,
  endValue,
  step,
  onStartChange,
  onEndChange,
}: RangeSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);

  const range = max - min || 1;
  const leftPercent = ((startValue - min) / range) * 100;
  const widthPercent = ((endValue - startValue) / range) * 100;

  const handleStartChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = Number(e.target.value);
      // Reason: Enforce minimum gap so user can't set start >= end
      if (val <= endValue - MIN_GAP_SECONDS) {
        onStartChange(val);
      }
    },
    [endValue, onStartChange]
  );

  const handleEndChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = Number(e.target.value);
      if (val >= startValue + MIN_GAP_SECONDS) {
        onEndChange(val);
      }
    },
    [startValue, onEndChange]
  );

  return (
    <div className="relative w-full h-8 flex items-center">
      {/* Background track */}
      <div
        ref={trackRef}
        className="absolute w-full h-1.5 bg-gray-200 rounded-full"
      />

      {/* Active range highlight */}
      <div
        className="absolute h-1.5 bg-purple-500 rounded-full"
        style={{
          left: `${leftPercent}%`,
          width: `${widthPercent}%`,
        }}
      />

      {/* Start handle */}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={startValue}
        onChange={handleStartChange}
        className="range-slider-thumb absolute w-full appearance-none bg-transparent pointer-events-none z-10"
        style={{ zIndex: startValue > max - range * 0.1 ? 20 : 10 }}
      />

      {/* End handle */}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={endValue}
        onChange={handleEndChange}
        className="range-slider-thumb absolute w-full appearance-none bg-transparent pointer-events-none z-10"
        style={{ zIndex: 15 }}
      />

      {/* Inline styles for range thumb pointer-events */}
      <style jsx>{`
        .range-slider-thumb::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: #7c3aed;
          border: 2px solid white;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
          cursor: pointer;
          pointer-events: auto;
        }
        .range-slider-thumb::-moz-range-thumb {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: #7c3aed;
          border: 2px solid white;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
          cursor: pointer;
          pointer-events: auto;
        }
        .range-slider-thumb::-webkit-slider-runnable-track {
          height: 0px;
        }
        .range-slider-thumb::-moz-range-track {
          height: 0px;
        }
      `}</style>
    </div>
  );
}
