'use client';

import { useCallback, useState } from 'react';

interface DropZoneProps {
  onFileSelect: (file: File) => void;
  disabled: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
}

/**
 * Drag-and-drop zone for file selection.
 * Handles drag events, click-to-browse, and visual feedback.
 *
 * Args:
 *   onFileSelect (function): Callback when a file is selected.
 *   disabled (boolean): Whether interaction is disabled.
 *   fileInputRef (RefObject): Ref to the hidden file input.
 */
export function DropZone({ onFileSelect, disabled, fileInputRef }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) setIsDragging(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (disabled) return;

      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile) onFileSelect(droppedFile);
    },
    [disabled, onFileSelect]
  );

  const handleClick = () => {
    if (!disabled && fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  return (
    <div
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`
        relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer
        transition-all duration-300 ease-in-out
        ${isDragging
          ? 'border-purple-500 bg-purple-50 scale-[1.02]'
          : 'border-gray-300 hover:border-purple-400 hover:bg-gray-50'
        }
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
    >
      <div className="flex flex-col items-center gap-3">
        <div className={`
          w-16 h-16 rounded-full flex items-center justify-center
          transition-all duration-300
          ${isDragging ? 'bg-purple-100 scale-110' : 'bg-gray-100'}
        `}>
          <svg
            className={`w-8 h-8 transition-colors ${isDragging ? 'text-purple-600' : 'text-gray-400'}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
            />
          </svg>
        </div>
        <div>
          <p className={`text-sm font-medium ${isDragging ? 'text-purple-600' : 'text-gray-700'}`}>
            {isDragging ? 'Drop your file here!' : 'Drag & drop your file here'}
          </p>
          <p className="text-xs text-gray-500 mt-1">or click to browse</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span className="px-2 py-1 bg-gray-100 rounded">MP4</span>
          <span className="px-2 py-1 bg-gray-100 rounded">M4A</span>
          <span className="px-2 py-1 bg-gray-100 rounded">MOV</span>
        </div>
      </div>
    </div>
  );
}
