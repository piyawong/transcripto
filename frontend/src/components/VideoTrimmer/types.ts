export interface TrimRange {
  startTime: number;
  endTime: number;
}

export interface VideoTrimmerProps {
  file: File;
  onTrimChange: (trimRange: TrimRange) => void;
}

export interface RangeSliderProps {
  min: number;
  max: number;
  startValue: number;
  endValue: number;
  step: number;
  onStartChange: (value: number) => void;
  onEndChange: (value: number) => void;
}

export interface TimeDisplayProps {
  label: string;
  seconds: number;
}
