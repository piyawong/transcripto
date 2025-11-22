'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api';
import { ShimmerButton } from '@/components/ui/shimmer-button';

export default function SearchPage() {
  const router = useRouter();
  const [taskId, setTaskId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!taskId.trim()) {
      setError('Please enter a task ID');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const task = await apiClient.searchTask(taskId);

      // Navigate based on task status
      if (task.status === 'completed') {
        router.push(`/result/${taskId}`);
      } else {
        router.push(`/progress/${taskId}`);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Task not found. Please check the ID and try again.');
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-12">
      <div className="max-w-md mx-auto">
        <h1 className="text-3xl font-bold mb-6 text-center">Find Your Task</h1>

        <div className="bg-white rounded-lg shadow-md p-6">
          <p className="text-gray-600 mb-4">
            Enter your task ID to view the progress or results of your transcription.
          </p>

          <form onSubmit={handleSearch} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Task ID
              </label>
              <input
                type="text"
                value={taskId}
                onChange={(e) => setTaskId(e.target.value)}
                placeholder="e.g., 123e4567-e89b-12d3-a456-426614174000"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={loading}
              />
            </div>

            {error && (
              <div className="p-3 bg-red-100 border border-red-400 text-red-700 rounded">
                {error}
              </div>
            )}

            <ShimmerButton
              type="submit"
              disabled={loading}
              className="w-full"
              shimmerColor="#60a5fa"
              background="linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)"
            >
              {loading ? 'Searching...' : 'Search Task'}
            </ShimmerButton>
          </form>
        </div>

        <div className="mt-6 p-4 bg-blue-50 rounded-lg">
          <h3 className="font-semibold text-sm mb-2">💡 Tip</h3>
          <p className="text-sm text-gray-600">
            Your task ID is provided when you upload a file and is also sent to your email.
            Keep it safe to track your transcription progress.
          </p>
        </div>
      </div>
    </div>
  );
}