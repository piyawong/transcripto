import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api';

export class ApiClient {
  private client = axios.create({
    baseURL: API_URL,
  });

  async getUploadUrl(filename: string, fileSize: number) {
    const response = await this.client.post('/v1/tasks/get_upload_url/', {
      filename,
      file_size: fileSize,
    });
    return response.data;
  }

  async uploadToGCS(uploadUrl: string, file: Blob, onProgress?: (percent: number) => void) {
    const response = await axios.put(uploadUrl, file, {
      headers: {
        'Content-Type': 'audio/wav',
      },
      onUploadProgress: (progressEvent) => {
        if (progressEvent.total && onProgress) {
          const percentCompleted = Math.round(
            (progressEvent.loaded * 100) / progressEvent.total
          );
          onProgress(percentCompleted);
        }
      },
    });
    return response;
  }

  async createTask(data: {
    email: string;
    original_filename: string;
    gcs_uri: string;
    file_size_bytes: number;
    duration_seconds: number;
  }) {
    const response = await this.client.post('/v1/tasks/', data);
    return response.data;
  }

  async getTask(taskId: string) {
    const response = await this.client.get(`/v1/tasks/${taskId}/`);
    return response.data;
  }

  async getProgress(taskId: string) {
    const response = await this.client.get(`/v1/tasks/${taskId}/progress/`);
    return response.data;
  }

  async getResult(taskId: string) {
    const response = await this.client.get(`/v1/tasks/${taskId}/result/`);
    return response.data;
  }

  async searchTask(taskId: string) {
    const response = await this.client.post('/v1/tasks/search/', {
      task_id: taskId,
    });
    return response.data;
  }

  // === Chunked Upload Methods ===

  async getChunkUploadUrl(taskId: string, chunkIndex: number, filename: string, fileSize: number) {
    const response = await this.client.post('/v1/tasks/get_upload_url/', {
      task_id: taskId,
      chunk_index: chunkIndex,
      filename,
      file_size: fileSize,
    });
    return response.data;
  }

  async createTaskWithChunks(data: {
    email: string;
    original_filename: string;
    file_size_bytes: number;
    duration_seconds: number;
    total_chunks: number;
    chunks_info: Array<{
      chunk_index: number;
      start_time_ms: number;
      end_time_ms: number;
      duration_ms: number;
    }>;
  }) {
    const response = await this.client.post('/v1/tasks/', data);
    return response.data;
  }

  async notifyChunkUploaded(taskId: string, data: {
    chunk_index: number;
    gcs_uri: string;
    file_size_bytes: number;
  }) {
    const response = await this.client.post(`/v1/tasks/${taskId}/chunk_uploaded/`, data);
    return response.data;
  }

  async getChunksStatus(taskId: string) {
    const response = await this.client.get(`/v1/tasks/${taskId}/chunks_status/`);
    return response.data;
  }
}

export const apiClient = new ApiClient();