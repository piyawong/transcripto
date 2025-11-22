'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { apiClient } from '@/lib/api';
import { AnimatedCircularProgressBar } from '@/components/ui/animated-circular-progress-bar';

export default function ProgressPage({ params }: { params: { taskId: string } }) {
  const router = useRouter();

  const { data, error } = useSWR(
    `/tasks/${params.taskId}/progress`,
    () => apiClient.getProgress(params.taskId),
    {
      refreshInterval: 5000, // Poll every 5 seconds
      revalidateOnFocus: true,
    }
  );

  useEffect(() => {
    if (data?.status === 'completed') {
      // Redirect to result page
      router.push(`/result/${params.taskId}`);
    }
  }, [data?.status, params.taskId, router]);

  if (error) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          Error loading task progress. Task may not exist.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Transcription Progress</h1>

      <div className="bg-white rounded-lg shadow-md p-6">
        <div className="mb-4">
          <p className="text-sm text-gray-600">Task ID: {params.taskId}</p>
          <p className="text-lg font-medium mt-2">
            Status: <span className="text-blue-600">{data?.status || 'Loading...'}</span>
          </p>
        </div>

        <div className="flex justify-center mb-6">
          <AnimatedCircularProgressBar
            value={data?.progress || 0}
            max={100}
            radius={80}
            strokeWidth={10}
            className="text-blue-600"
          />
        </div>

        <div className="mb-4">
          <div className="flex justify-between text-sm text-gray-600 mb-2">
            <span>Progress</span>
            <span>{data?.progress || 0}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div
              className="bg-blue-600 h-3 rounded-full transition-all duration-500"
              style={{ width: `${data?.progress || 0}%` }}
            />
          </div>
        </div>

        <p className="text-sm text-gray-600 mt-4">
          Current Step: {data?.step || 'Initializing...'}
        </p>
      </div>
    </div>
  );
}