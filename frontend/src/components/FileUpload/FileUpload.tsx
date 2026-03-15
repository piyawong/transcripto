'use client';

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api';
import { ShimmerButton } from '@/components/ui/shimmer-button';
import { AnimatedCircularProgressBar } from '@/components/ui/animated-circular-progress-bar';
import { AnimatedGradientText } from '@/components/ui/animated-gradient-text';
import { VideoTrimmer } from '@/components/VideoTrimmer';
import type { TrimRange } from '@/components/VideoTrimmer';
import { DropZone } from './DropZone';

interface FileUploadProps {
  onUploadComplete?: (taskId: string) => void;
}

interface ChunkInfo {
  chunk_index: number;
  start_time_ms: number;
  end_time_ms: number;
  duration_ms: number;
}

interface ChunkBlob {
  blob: Blob;
  info: ChunkInfo;
}

// Configuration
const CHUNK_DURATION_SECONDS = 30 * 60; // 30 minute chunks (1800 seconds)
const MAX_CONCURRENT_UPLOADS = 3;

export function FileUpload({ onUploadComplete }: FileUploadProps) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [email, setEmail] = useState('');
  const [processing, setProcessing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [conversionProgress, setConversionProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState('');
  const [error, setError] = useState('');
  const [chunksUploaded, setChunksUploaded] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [trimRange, setTrimRange] = useState<TrimRange | null>(null);
  const ffmpegRef = useRef<any>(null);
  const ffmpegLoaded = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFFmpeg = async () => {
    if (ffmpegLoaded.current && ffmpegRef.current) return;

    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');

    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    const ffmpeg = new FFmpeg();
    ffmpegRef.current = ffmpeg;

    ffmpeg.on('progress', ({ progress }) => {
      setConversionProgress(Math.round(progress * 100));
    });

    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    ffmpegLoaded.current = true;
  };

  const validateFile = (selectedFile: File): boolean => {
    const validTypes = ['video/mp4', 'audio/m4a', 'video/quicktime'];
    const ext = selectedFile.name.toLowerCase().split('.').pop();

    if (!validTypes.includes(selectedFile.type) && !['mp4', 'm4a', 'mov'].includes(ext || '')) {
      setError('Please upload an MP4, M4A, or MOV file');
      return false;
    }

    return true;
  };

  const getAudioDuration = async (ffmpeg: any): Promise<number> => {
    const wavData = await ffmpeg.readFile('output.wav');
    const fileSize = (wavData as Uint8Array).length;

    // For 16kHz mono 16-bit WAV:
    // Byte rate = 16000 * 2 * 1 = 32000 bytes/sec
    // WAV header is typically 44 bytes
    const BYTE_RATE = 32000;
    const HEADER_SIZE = 44;

    const dataSize = fileSize - HEADER_SIZE;
    const durationSeconds = Math.ceil(dataSize / BYTE_RATE);

    console.log(`[Transcripto] WAV file size: ${fileSize} bytes`);
    console.log(`[Transcripto] Data size: ${dataSize} bytes`);
    console.log(`[Transcripto] Calculated duration: ${durationSeconds} seconds (${(durationSeconds/60).toFixed(1)} minutes)`);

    return durationSeconds;
  };

  /**
   * Convert input file to WAV and split into chunks.
   * When trimStart/trimEnd are provided, only the trimmed portion is converted.
   */
  const convertAndSplitToChunks = async (
    inputFile: File,
    trimStart?: number,
    trimEnd?: number,
  ): Promise<{
    chunks: ChunkBlob[];
    totalDuration: number;
    totalSize: number;
  }> => {
    const ffmpeg = ffmpegRef.current;
    const { fetchFile } = await import('@ffmpeg/util');

    await ffmpeg.writeFile('input.mp4', await fetchFile(inputFile));

    // Build FFmpeg args with optional trim params
    setCurrentStep('Converting to WAV format...');
    const ffmpegArgs = ['-i', 'input.mp4'];

    // Reason: Add -ss/-t before output to trim at the input stage for faster conversion
    if (trimStart != null && trimEnd != null && (trimStart > 0 || trimEnd < Infinity)) {
      ffmpegArgs.push('-ss', trimStart.toString());
      ffmpegArgs.push('-t', (trimEnd - trimStart).toString());
      console.log(`[Transcripto] Trimming: ${trimStart}s to ${trimEnd}s (${trimEnd - trimStart}s)`);
    }

    ffmpegArgs.push('-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', 'output.wav');

    await ffmpeg.exec(ffmpegArgs);

    const totalDuration = await getAudioDuration(ffmpeg);
    const fullWavData = await ffmpeg.readFile('output.wav');
    const totalSize = (fullWavData as Uint8Array).length;

    const numChunks = Math.ceil(totalDuration / CHUNK_DURATION_SECONDS);
    setTotalChunks(numChunks);

    console.log(`[Transcripto] CHUNK_DURATION_SECONDS: ${CHUNK_DURATION_SECONDS}`);
    console.log(`[Transcripto] Total duration: ${totalDuration} sec, Chunks needed: ${numChunks}`);

    if (numChunks <= 1) {
      return {
        chunks: [{
          blob: new Blob([fullWavData], { type: 'audio/wav' }),
          info: {
            chunk_index: 0,
            start_time_ms: 0,
            end_time_ms: totalDuration * 1000,
            duration_ms: totalDuration * 1000,
          }
        }],
        totalDuration,
        totalSize,
      };
    }

    setCurrentStep(`Splitting into ${numChunks} chunks...`);
    const chunks: ChunkBlob[] = [];

    for (let i = 0; i < numChunks; i++) {
      const startTime = i * CHUNK_DURATION_SECONDS;
      const endTime = Math.min((i + 1) * CHUNK_DURATION_SECONDS, totalDuration);
      const chunkDuration = endTime - startTime;

      setConversionProgress(Math.round(((i + 1) / numChunks) * 100));

      await ffmpeg.exec([
        '-i', 'output.wav',
        '-ss', startTime.toString(),
        '-t', chunkDuration.toString(),
        '-acodec', 'pcm_s16le',
        '-ar', '16000',
        '-ac', '1',
        `chunk_${i}.wav`
      ]);

      const chunkData = await ffmpeg.readFile(`chunk_${i}.wav`);
      const chunkBlob = new Blob([chunkData], { type: 'audio/wav' });

      chunks.push({
        blob: chunkBlob,
        info: {
          chunk_index: i,
          start_time_ms: startTime * 1000,
          end_time_ms: endTime * 1000,
          duration_ms: chunkDuration * 1000,
        }
      });

      await ffmpeg.deleteFile(`chunk_${i}.wav`);
    }

    await ffmpeg.deleteFile('input.mp4');
    await ffmpeg.deleteFile('output.wav');

    return { chunks, totalDuration, totalSize };
  };

  const uploadChunk = async (
    taskId: string,
    chunk: ChunkBlob,
    onProgress: (chunkIndex: number, progress: number) => void
  ): Promise<void> => {
    const { blob, info } = chunk;
    const filename = `chunk_${info.chunk_index}.wav`;

    const { upload_url, gcs_uri } = await apiClient.getChunkUploadUrl(
      taskId,
      info.chunk_index,
      filename,
      blob.size
    );

    await apiClient.uploadToGCS(upload_url, blob, (percent) => {
      onProgress(info.chunk_index, percent);
    });

    await apiClient.notifyChunkUploaded(taskId, {
      chunk_index: info.chunk_index,
      gcs_uri,
      file_size_bytes: blob.size,
    });
  };

  const uploadChunksInParallel = async (
    taskId: string,
    chunks: ChunkBlob[]
  ): Promise<void> => {
    const chunkProgresses: number[] = new Array(chunks.length).fill(0);
    let completedChunks = 0;

    const updateOverallProgress = () => {
      const avgProgress = chunkProgresses.reduce((a, b) => a + b, 0) / chunks.length;
      setUploadProgress(Math.round(avgProgress));
    };

    const onChunkProgress = (chunkIndex: number, progress: number) => {
      chunkProgresses[chunkIndex] = progress;
      updateOverallProgress();
    };

    for (let i = 0; i < chunks.length; i += MAX_CONCURRENT_UPLOADS) {
      const batch = chunks.slice(i, i + MAX_CONCURRENT_UPLOADS);

      await Promise.all(
        batch.map(async (chunk) => {
          await uploadChunk(taskId, chunk, onChunkProgress);
          completedChunks++;
          setChunksUploaded(completedChunks);
        })
      );
    }
  };

  const handleFileSelect = useCallback((selectedFile: File) => {
    if (validateFile(selectedFile)) {
      setFile(selectedFile);
      setError('');
      setTrimRange(null);
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) handleFileSelect(selectedFile);
  };

  const handleTrimChange = useCallback((range: TrimRange) => {
    setTrimRange(range);
  }, []);

  const removeFile = () => {
    setFile(null);
    setTrimRange(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!file || !email) {
      setError('Please select a file and enter your email');
      return;
    }

    setProcessing(true);
    setError('');
    setUploadProgress(0);
    setConversionProgress(0);
    setChunksUploaded(0);
    setTotalChunks(0);

    try {
      setCurrentStep('Initializing audio processor...');
      await loadFFmpeg();

      setCurrentStep('Converting and splitting audio...');
      const { chunks, totalDuration, totalSize } = await convertAndSplitToChunks(
        file,
        trimRange?.startTime,
        trimRange?.endTime,
      );

      setCurrentStep(`Created ${chunks.length} chunks. Preparing upload...`);

      const response = await apiClient.createTaskWithChunks({
        email,
        original_filename: file.name,
        file_size_bytes: totalSize,
        duration_seconds: totalDuration,
        total_chunks: chunks.length,
        chunks_info: chunks.map(c => c.info),
      });

      const taskId = response.task_id;

      setCurrentStep(`Uploading ${chunks.length} chunks...`);
      await uploadChunksInParallel(taskId, chunks);

      setCurrentStep('All chunks uploaded! Processing started...');

      if (onUploadComplete) {
        onUploadComplete(taskId);
      }

      router.push(`/progress/${taskId}`);
    } catch (err: any) {
      console.error('Processing error:', err);
      setError(err.response?.data?.error || err.message || 'Processing failed. Please try again.');
      setProcessing(false);
    }
  };

  return (
    <div className="max-w-md mx-auto p-6 bg-white/90 dark:bg-gray-900/90 backdrop-blur-lg rounded-xl shadow-2xl border border-gray-200 dark:border-gray-800">
      <AnimatedGradientText className="mb-4">
        <span className="text-2xl font-bold">Transcripto Audio Processing</span>
      </AnimatedGradientText>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Select MP4/M4A/MOV File
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".mp4,.m4a,.mov"
            onChange={handleFileChange}
            disabled={processing}
            className="hidden"
          />

          {!file ? (
            <DropZone
              onFileSelect={handleFileSelect}
              disabled={processing}
              fileInputRef={fileInputRef}
            />
          ) : (
            <div className="space-y-3">
              {/* File info card */}
              <div className="border border-gray-200 rounded-xl p-4 bg-gradient-to-r from-purple-50 to-blue-50">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-lg bg-purple-100 flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15.536a5 5 0 001.414 1.414m2.828-9.9a9 9 0 0112.728 0" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{file.name}</p>
                    <p className="text-xs text-gray-500">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                  </div>
                  {!processing && (
                    <button
                      type="button"
                      onClick={removeFile}
                      className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>

              {/* Video trimmer */}
              {!processing && (
                <VideoTrimmer file={file} onTrimChange={handleTrimChange} />
              )}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Email Address
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={processing}
            required
            placeholder="your@email.com"
            className="w-full px-3 py-2 border border-gray-300 rounded-md"
          />
        </div>

        {error && (
          <div className="p-3 bg-red-100 border border-red-400 text-red-700 rounded">
            {error}
          </div>
        )}

        {currentStep && (
          <div className="p-3 bg-blue-50 border border-blue-200 text-blue-700 rounded">
            <p className="text-sm font-medium">{currentStep}</p>

            {conversionProgress > 0 && conversionProgress < 100 && (
              <div className="mt-2 flex items-center gap-4">
                <AnimatedCircularProgressBar
                  value={conversionProgress}
                  max={100}
                  radius={30}
                  strokeWidth={4}
                  className="text-blue-600"
                />
                <div className="flex-1">
                  <div className="text-xs font-medium">Converting/Splitting Audio</div>
                  <div className="text-xs text-gray-500">Preparing chunks for upload...</div>
                </div>
              </div>
            )}

            {uploadProgress > 0 && (
              <div className="mt-2 flex items-center gap-4">
                <AnimatedCircularProgressBar
                  value={uploadProgress}
                  max={100}
                  radius={30}
                  strokeWidth={4}
                  className="text-green-600"
                />
                <div className="flex-1">
                  <div className="text-xs font-medium">Uploading to Cloud</div>
                  <div className="text-xs text-gray-500">
                    {chunksUploaded}/{totalChunks} chunks completed
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <ShimmerButton
          type="submit"
          disabled={processing || !file || !email}
          className="w-full"
          shimmerColor="#60a5fa"
          background="linear-gradient(135deg, #667eea 0%, #764ba2 100%)"
        >
          {processing ? 'Processing...' : 'Convert and Start Transcription'}
        </ShimmerButton>
      </form>
    </div>
  );
}
