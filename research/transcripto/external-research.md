# External Research - Transcripto

## Google Cloud Speech-to-Text API

### Documentation & Setup
- **Official Documentation**: https://cloud.google.com/speech-to-text/docs
- **Python Client Library**: https://cloud.google.com/python/docs/reference/speech/latest
- **Codelabs Tutorial**: https://codelabs.developers.google.com/codelabs/cloud-speech-text-python3

### Key Implementation Details
```python
# Installation
pip install google-cloud-speech

# Basic usage
from google.cloud import speech

client = speech.SpeechClient()

# Configuration for transcription
config = speech.RecognitionConfig(
    encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
    sample_rate_hertz=16000,
    language_code="en-US",
    enable_automatic_punctuation=True,
    enable_speaker_diarization=True,
    diarization_speaker_count=2,
)

# For long audio files (>1 minute), use long_running_recognize
operation = client.long_running_recognize(config=config, audio=audio)
```

### Limitations & Best Practices
- **File size limits**: Files <1 minute can be processed locally, larger files need Google Cloud Storage
- **Batch processing**: Optimal batch sizes for API quota management
- **Authentication**: Service account JSON key required
- **Quotas**: Default 900 requests per minute, 1.5M minutes per month
- **Supported formats**: WAV, FLAC, MP3, OGG_OPUS, WEBM_OPUS

## Django + Celery + Redis Architecture

### Documentation
- **Django REST Framework**: https://www.django-rest-framework.org/
- **Celery Documentation**: https://docs.celeryq.dev/
- **Redis with Django**: https://realpython.com/asynchronous-tasks-with-django-and-celery/

### Modern Stack (2025)
```python
# Django 5.1.7 + Celery 5.4.0 + Redis 5.2.1

# celery.py configuration
from celery import Celery

app = Celery('core')
app.config_from_object('django.conf:settings', namespace='CELERY')
app.autodiscover_tasks()

# Settings
CELERY_BROKER_URL = "redis://redis:6379/0"
CELERY_RESULT_BACKEND = "redis://redis:6379/0"
CELERY_TASK_TRACK_STARTED = True
CELERY_TASK_TIME_LIMIT = 30 * 60  # 30 minutes
```

### Task Queue Patterns
```python
# Celery task with retry logic
@shared_task(bind=True, max_retries=3, default_retry_delay=60)
def process_audio_batch(self, task_id, batch_number):
    try:
        # Processing logic
        pass
    except Exception as exc:
        raise self.retry(exc=exc, countdown=60 * (self.request.retries + 1))
```

## Audio Processing with FFmpeg

### Documentation
- **FFmpeg Python**: https://www.gumlet.com/learn/ffmpeg-python/
- **PyDub Library**: https://github.com/jiaaro/pydub

### MP4 to WAV Conversion
```python
# Using ffmpeg-python
import ffmpeg

def convert_mp4_to_wav(input_path, output_path):
    stream = ffmpeg.input(input_path)
    stream = ffmpeg.output(stream, output_path,
                          acodec='pcm_s16le',  # 16-bit PCM
                          ar='16000',          # 16kHz sample rate
                          ac=1)                # Mono
    ffmpeg.run(stream, overwrite_output=True)

# Using pydub (simpler API)
from pydub import AudioSegment

def convert_with_pydub(input_path, output_path):
    audio = AudioSegment.from_mp4(input_path)
    audio = audio.set_frame_rate(16000).set_channels(1)
    audio.export(output_path, format="wav")
```

### Batch Processing Strategy
```python
def split_audio_into_chunks(audio_path, chunk_duration_ms=60000):
    """Split audio into 1-minute chunks for processing"""
    audio = AudioSegment.from_wav(audio_path)
    chunks = []

    for i in range(0, len(audio), chunk_duration_ms):
        chunk = audio[i:i + chunk_duration_ms]
        chunks.append(chunk)

    return chunks
```

## LangChain Text Processing

### Documentation
- **LangChain Python**: https://python.langchain.com/docs/get_started/introduction
- **Text Splitters**: https://python.langchain.com/docs/concepts/text_splitters

### Text Processing Pipeline
```python
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain.schema import Document

# Text cleaning and formatting
def process_transcription(raw_text):
    # Split into manageable chunks
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000,
        chunk_overlap=200,
        separators=["\n\n", "\n", " ", ""]
    )

    documents = text_splitter.create_documents([raw_text])

    # Clean and format
    cleaned_text = clean_transcription_text(raw_text)

    return cleaned_text

def clean_transcription_text(text):
    """Remove filler words, fix punctuation, format paragraphs"""
    # Remove common transcription artifacts
    text = text.replace("[NOISE]", "")
    text = text.replace("[INAUDIBLE]", "...")

    # Fix spacing and punctuation
    import re
    text = re.sub(r'\s+', ' ', text)  # Multiple spaces to single
    text = re.sub(r'\s+([.,!?])', r'\1', text)  # Fix punctuation spacing

    return text.strip()
```

## Email Notifications with SendGrid

### Documentation
- **SendGrid Python SDK**: https://github.com/sendgrid/sendgrid-python
- **Django-SendGrid Integration**: https://anymail.dev/

### Implementation Pattern
```python
# Using SendGrid with Django
from sendgrid import SendGridAPIClient
from sendgrid.helpers.mail import Mail

def send_progress_email(email, task_id, progress_url):
    message = Mail(
        from_email='noreply@transcripto.com',
        to_emails=email,
        subject='Your Transcription is Processing',
        html_content=f'''
        <h2>Transcription Task Started</h2>
        <p>Task ID: {task_id}</p>
        <p>Track progress: <a href="{progress_url}">View Progress</a></p>
        '''
    )

    try:
        sg = SendGridAPIClient(api_key=settings.SENDGRID_API_KEY)
        response = sg.send(message)
    except Exception as e:
        logger.error(f"Email send failed: {e}")
```

## Docker Best Practices for 2025

### Multi-stage Builds
```dockerfile
# Backend Dockerfile
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --user -r requirements.txt

FROM python:3.12-slim
WORKDIR /app
COPY --from=builder /root/.local /root/.local
COPY . .
ENV PATH=/root/.local/bin:$PATH
CMD ["gunicorn", "core.wsgi:application", "--bind", "0.0.0.0:8000"]

# Frontend Dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV production
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules
USER nextjs
CMD ["npm", "start"]
```

### Docker Compose Configuration
```yaml
version: '3.9'

services:
  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: transcripto
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 5

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://postgres:postgres@db:5432/transcripto
      REDIS_URL: redis://redis:6379
    volumes:
      - media_files:/app/media
      - static_files:/app/static

  celery:
    build:
      context: ./backend
      dockerfile: Dockerfile
    command: celery -A core worker -l info --concurrency=4
    depends_on:
      - redis
      - db
    environment:
      DATABASE_URL: postgresql://postgres:postgres@db:5432/transcripto
      REDIS_URL: redis://redis:6379

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    depends_on:
      - backend
    environment:
      NEXT_PUBLIC_API_URL: http://backend:8000/api

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - static_files:/static
      - media_files:/media
    depends_on:
      - backend
      - frontend

volumes:
  postgres_data:
  redis_data:
  media_files:
  static_files:
```

## Next.js + React Best Practices

### Server Components & Data Fetching
```typescript
// app/progress/[taskId]/page.tsx
async function getTaskProgress(taskId: string) {
  const res = await fetch(`${process.env.API_URL}/api/tasks/${taskId}`, {
    next: { revalidate: 5 } // Revalidate every 5 seconds
  });

  if (!res.ok) throw new Error('Failed to fetch');

  return res.json();
}

export default async function ProgressPage({ params }: { params: { taskId: string } }) {
  const progress = await getTaskProgress(params.taskId);
  return <ProgressTracker initialProgress={progress} taskId={params.taskId} />;
}
```

### Real-time Updates with SWR
```typescript
import useSWR from 'swr';

function useTaskProgress(taskId: string) {
  const { data, error, mutate } = useSWR(
    `/api/tasks/${taskId}/progress`,
    fetcher,
    {
      refreshInterval: 2000, // Poll every 2 seconds
      revalidateOnFocus: true,
    }
  );

  return {
    progress: data,
    isLoading: !error && !data,
    isError: error,
    mutate,
  };
}
```

## Performance Optimization Tips

1. **Audio Processing**
   - Convert to 16kHz mono WAV for optimal Speech-to-Text performance
   - Process in 1-minute chunks to avoid API timeouts
   - Use parallel processing for multiple chunks

2. **Database Optimization**
   - Index task_id and status fields
   - Use database connection pooling
   - Cache frequently accessed data in Redis

3. **API Performance**
   - Implement pagination for list endpoints
   - Use Django's select_related() and prefetch_related()
   - Enable CORS caching headers

4. **Frontend Performance**
   - Use Next.js Image component for optimized loading
   - Implement virtual scrolling for long lists
   - Use React.memo() for expensive components