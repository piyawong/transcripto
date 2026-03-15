'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { RangeSlider } from './RangeSlider';
import { TimeDisplay } from './TimeDisplay';
import { formatTime, getStepSize } from './utils';
import type { VideoTrimmerProps } from './types';

/**
 * Video preview with dual-handle range slider for selecting trim range.
 * Creates a blob URL from the file for <video> preview, and reports
 * trim range changes to the parent component.
 *
 * Args:
 *   file (File): The video/audio file to preview.
 *   onTrimChange (function): Callback with { startTime, endTime } in seconds.
 */
export function VideoTrimmer({ file, onTrimChange }: VideoTrimmerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isTrimmed, setIsTrimmed] = useState(false);

  // Create and clean up object URL
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setVideoUrl(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // Handle video metadata loaded
  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video || !isFinite(video.duration)) return;

    const dur = Math.floor(video.duration);
    setDuration(dur);
    setStartTime(0);
    setEndTime(dur);
    onTrimChange({ startTime: 0, endTime: dur });
  }, [onTrimChange]);

  // Handle start time change
  const handleStartChange = useCallback(
    (value: number) => {
      setStartTime(value);
      setIsTrimmed(value > 0 || endTime < duration);
      onTrimChange({ startTime: value, endTime });

      // Seek video to start position for preview
      if (videoRef.current) {
        videoRef.current.currentTime = value;
      }
    },
    [endTime, duration, onTrimChange]
  );

  // Handle end time change
  const handleEndChange = useCallback(
    (value: number) => {
      setEndTime(value);
      setIsTrimmed(startTime > 0 || value < duration);
      onTrimChange({ startTime, endTime: value });
    },
    [startTime, duration, onTrimChange]
  );

  if (!videoUrl) return null;

  const selectedDuration = endTime - startTime;
  const step = getStepSize(duration);
  const isVideoFile = file.type.startsWith('video/') || file.name.match(/\.(mp4|mov)$/i);

  return (
    <div className="border border-gray-200 rounded-xl p-4 bg-gradient-to-b from-gray-50 to-white space-y-3">
      {/* Video preview */}
      {isVideoFile && (
        <video
          ref={videoRef}
          src={videoUrl}
          onLoadedMetadata={handleLoadedMetadata}
          className="w-full max-h-48 rounded-lg bg-black object-contain"
          muted
          preload="metadata"
        />
      )}

      {/* Audio-only fallback: hidden video element to get duration */}
      {!isVideoFile && (
        <video
          ref={videoRef}
          src={videoUrl}
          onLoadedMetadata={handleLoadedMetadata}
          className="hidden"
          preload="metadata"
        />
      )}

      {duration > 0 && (
        <>
          {/* Time displays */}
          <div className="flex items-center justify-between px-1">
            <TimeDisplay label="Start" seconds={startTime} />
            <div className="flex flex-col items-center">
              <span className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">
                Duration
              </span>
              <span className="text-sm font-mono font-semibold text-purple-600">
                {formatTime(duration)}
              </span>
            </div>
            <TimeDisplay label="End" seconds={endTime} />
          </div>

          {/* Range slider */}
          <div className="px-1">
            <RangeSlider
              min={0}
              max={duration}
              startValue={startTime}
              endValue={endTime}
              step={step}
              onStartChange={handleStartChange}
              onEndChange={handleEndChange}
            />
          </div>

          {/* Trim info */}
          {isTrimmed && (
            <div className="flex items-center justify-center gap-2 text-xs text-purple-600 bg-purple-50 rounded-lg py-1.5">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z"
                />
              </svg>
              <span>
                Trimming: {formatTime(startTime)} - {formatTime(endTime)}{' '}
                ({formatTime(selectedDuration)} selected)
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
