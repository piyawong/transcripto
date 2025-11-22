'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { apiClient } from '@/lib/api';
import { AnimatedCircularProgressBar } from '@/components/ui/animated-circular-progress-bar';

export default function ProgressPage({ params }: { params: { taskId: string } }) {
  const router = useRouter();
  const [elapsedTime, setElapsedTime] = useState(0);
  const [startTime] = useState(Date.now());

  const { data, error } = useSWR(
    `/tasks/${params.taskId}/progress`,
    () => apiClient.getProgress(params.taskId),
    {
      refreshInterval: 5000,
      revalidateOnFocus: true,
    }
  );

  useEffect(() => {
    if (data?.status === 'completed') {
      router.push(`/result/${params.taskId}`);
    }
  }, [data?.status, params.taskId, router]);

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [startTime]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'processing':
        return 'text-blue-600';
      case 'completed':
        return 'text-green-600';
      case 'failed':
        return 'text-red-600';
      default:
        return 'text-gray-600';
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'processing':
        return 'bg-blue-100 text-blue-700';
      case 'completed':
        return 'bg-green-100 text-green-700';
      case 'failed':
        return 'bg-red-100 text-red-700';
      default:
        return 'bg-gray-100 text-gray-700';
    }
  };

  if (error) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="bg-red-50 border border-red-200 text-red-700 px-6 py-4 rounded-xl">
          <div className="flex items-center gap-3">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Error loading task progress. Task may not exist.</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      {/* Header with gradient */}
      <div className="bg-gradient-to-r from-purple-600 to-blue-600 rounded-t-2xl p-6 text-white">
        <h1 className="text-2xl font-bold mb-2">Transcription Progress</h1>
        <p className="text-purple-100 text-sm">Your audio is being processed by our AI</p>
      </div>

      {/* Main content card */}
      <div className="bg-white rounded-b-2xl shadow-xl border border-gray-100">
        {/* Task Info */}
        <div className="p-6 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Task ID</p>
              <p className="text-sm font-mono text-gray-700 bg-gray-50 px-3 py-1 rounded-lg">
                {params.taskId.slice(0, 8)}...{params.taskId.slice(-4)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Status</p>
              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium ${getStatusBadge(data?.status || 'pending')}`}>
                {data?.status === 'processing' && (
                  <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span>
                )}
                {data?.status || 'Loading...'}
              </span>
            </div>
          </div>
        </div>

        {/* Progress Circle */}
        <div className="py-8 flex flex-col items-center">
          <div className="relative">
            <AnimatedCircularProgressBar
              value={data?.progress || 0}
              max={100}
              radius={80}
              strokeWidth={10}
              className="text-purple-600"
            />
          </div>

          {/* Progress Stats */}
          <div className="mt-6 grid grid-cols-2 gap-8 text-center">
            <div>
              <p className="text-3xl font-bold text-gray-800">{data?.progress || 0}%</p>
              <p className="text-sm text-gray-500">Complete</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-gray-800">{formatTime(elapsedTime)}</p>
              <p className="text-sm text-gray-500">Elapsed</p>
            </div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="px-6 pb-6">
          <div className="flex justify-between text-sm text-gray-600 mb-2">
            <span>Progress</span>
            <span>{data?.progress || 0}%</span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-3 overflow-hidden">
            <div
              className="bg-gradient-to-r from-purple-500 to-blue-500 h-3 rounded-full transition-all duration-700 ease-out"
              style={{ width: `${data?.progress || 0}%` }}
            />
          </div>
        </div>

        {/* Current Step */}
        <div className="px-6 pb-6">
          <div className="bg-gradient-to-r from-purple-50 to-blue-50 rounded-xl p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center">
                <svg className="w-5 h-5 text-purple-600 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-800">Current Step</p>
                <p className="text-sm text-gray-600">{data?.step || 'Initializing...'}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Footer info */}
        <div className="px-6 pb-6">
          <p className="text-xs text-gray-400 text-center">
            This page updates automatically every 5 seconds. You can safely close this page - we'll email you when it's done!
          </p>
        </div>
      </div>
    </div>
  );
}
