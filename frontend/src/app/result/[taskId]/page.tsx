'use client';

import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api';
import { TranscriptionTask, TranscriptionResult } from '@/types';
import { ShimmerButton } from '@/components/ui/shimmer-button';

export default function ResultPage({ params }: { params: { taskId: string } }) {
  const [task, setTask] = useState<TranscriptionTask | null>(null);
  const [result, setResult] = useState<TranscriptionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchResult = async () => {
      try {
        const taskData = await apiClient.getTask(params.taskId);
        setTask(taskData);

        if (taskData.status === 'completed') {
          const resultData = await apiClient.getResult(params.taskId);
          setResult(resultData);
        } else if (taskData.status === 'failed') {
          setError(taskData.error_message || 'Task failed');
        }
      } catch (err: any) {
        setError(err.response?.data?.error || 'Failed to load result');
      } finally {
        setLoading(false);
      }
    };

    fetchResult();
  }, [params.taskId]);

  const downloadTranscript = () => {
    if (!result) return;

    const blob = new Blob([result.processed_transcription], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${params.taskId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex justify-center items-center h-64">
          <div className="text-lg">Loading result...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-yellow-100 border border-yellow-400 text-yellow-700 px-4 py-3 rounded">
          Task is not yet completed. Status: {task?.status}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Transcription Result</h1>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-semibold mb-4">Task Information</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="font-medium">File:</span> {task?.original_filename}
          </div>
          <div>
            <span className="font-medium">Status:</span>
            <span className="ml-2 text-green-600">Completed</span>
          </div>
          <div>
            <span className="font-medium">Word Count:</span> {result.word_count}
          </div>
          <div>
            <span className="font-medium">Confidence:</span> {(result.confidence_score * 100).toFixed(1)}%
          </div>
          <div>
            <span className="font-medium">Speakers:</span> {result.speakers_detected}
          </div>
          <div>
            <span className="font-medium">Processing Time:</span> {result.processing_time_seconds.toFixed(1)}s
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold">Transcription</h2>
          <ShimmerButton
            onClick={downloadTranscript}
            className="px-4 py-2"
            shimmerColor="#10b981"
            background="linear-gradient(135deg, #059669 0%, #047857 100%)"
          >
            Download Transcript
          </ShimmerButton>
        </div>

        <div className="prose max-w-none">
          <div className="bg-gray-50 p-4 rounded-lg max-h-96 overflow-y-auto">
            <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans">
              {result.processed_transcription}
            </pre>
          </div>
        </div>
      </div>

      <div className="text-center">
        <ShimmerButton
          onClick={() => window.location.href = '/'}
          className="px-6 py-3"
          shimmerColor="#6366f1"
          background="linear-gradient(135deg, #4f46e5 0%, #4338ca 100%)"
        >
          Process Another File
        </ShimmerButton>
      </div>
    </div>
  );
}