export interface TranscriptionTask {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  email: string;
  original_filename: string;
  file_size_bytes: number;
  duration_seconds?: number;
  progress_percentage: number;
  current_step: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  error_message?: string;
  result?: TranscriptionResult;
}

export interface TranscriptionResult {
  processed_transcription: string;
  word_count: number;
  confidence_score: number;
  speakers_detected: number;
  processing_time_seconds: number;
  langchain_metadata: Record<string, any>;
}

export interface ProgressData {
  progress: number;
  step: string;
  status: string;
}

export interface UploadInfo {
  upload_url: string;
  gcs_uri: string;
  blob_name: string;
}