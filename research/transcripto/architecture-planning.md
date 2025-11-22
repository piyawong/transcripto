# Architecture Planning - Transcripto

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Browser                             │
├─────────────────────────────────────────────────────────────────┤
│                    Next.js Frontend (Port 3000)                  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐    │
│  │ Upload Page  │ │Progress Page │ │  Search Task Page    │    │
│  └──────────────┘ └──────────────┘ └──────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ↓ HTTP/WebSocket
┌─────────────────────────────────────────────────────────────────┐
│                    NGINX Reverse Proxy (Port 80)                 │
└─────────────────────────────────────────────────────────────────┘
                    │                           │
                    ↓                           ↓
┌──────────────────────────┐    ┌────────────────────────────────┐
│  Django Backend (8000)    │    │   Static/Media Files           │
│  ┌────────────────────┐  │    └────────────────────────────────┘
│  │  REST API          │  │
│  │  - Upload endpoint │  │
│  │  - Progress API    │  │
│  │  - Task search     │  │
│  └────────────────────┘  │
└──────────────────────────┘
            │
            ↓ Task Queue
┌──────────────────────────┐    ┌────────────────────────────────┐
│  Redis Message Broker     │←───│  Celery Workers (4 instances)  │
│  - Task queue             │    │  - Audio processing            │
│  - Result backend         │    │  - Google Cloud transcription  │
│  - Cache                  │    │  - Email notifications         │
└──────────────────────────┘    └────────────────────────────────┘
            │                                    │
            ↓                                    ↓
┌──────────────────────────┐    ┌────────────────────────────────┐
│  PostgreSQL Database      │    │  Google Cloud Speech-to-Text   │
│  - Tasks table            │    │  - Audio transcription         │
│  - Results table          │    │  - Speaker diarization         │
│  - Progress tracking      │    └────────────────────────────────┘
└──────────────────────────┘                    │
            │                                    ↓
            ↓                    ┌────────────────────────────────┐
┌──────────────────────────┐    │  LangChain Text Processing     │
│  SendGrid Email Service   │    │  - Text formatting             │
│  - Progress notifications │    │  - Punctuation fixing          │
│  - Completion alerts      │    └────────────────────────────────┘
└──────────────────────────┘
```

## Data Flow Architecture

### 1. File Upload Flow
```
User → Upload MP4 → Next.js → Django API → Create Task →
→ Store File → Queue Celery Task → Return Task ID →
→ Redirect to Progress Page
```

### 2. Audio Processing Pipeline
```
Celery Worker → Fetch Task → Load MP4 File →
→ Convert to WAV (ffmpeg) → Split into chunks →
→ Process each chunk:
  - Upload to Google Cloud Storage (if needed)
  - Call Speech-to-Text API
  - Store partial results
  - Update progress (20%, 40%, 60%...)
→ Combine all transcriptions →
→ Process with LangChain (formatting, cleanup) →
→ Store final result → Update task status
```

### 3. Progress Tracking Flow
```
Frontend (polling/websocket) → Django API →
→ Check Redis cache → If miss: Query PostgreSQL →
→ Return progress data → Update UI
```

### 4. Email Notification Flow
```
Task Created → Queue email task → Send "Processing Started" →
Task at 50% → Queue email task → Send "Halfway Complete" →
Task Complete → Queue email task → Send "Ready for Download"
```

## Database Schema Design

### PostgreSQL Tables

```sql
-- Tasks table
CREATE TABLE transcription_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status VARCHAR(20) DEFAULT 'pending',
    email VARCHAR(255),
    original_filename VARCHAR(255),
    file_path VARCHAR(500),
    file_size_bytes BIGINT,
    duration_seconds INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    error_message TEXT,
    progress_percentage INTEGER DEFAULT 0,
    current_step VARCHAR(100),
    INDEX idx_status_created (status, created_at),
    INDEX idx_email (email)
);

-- Transcription results table
CREATE TABLE transcription_results (
    id SERIAL PRIMARY KEY,
    task_id UUID REFERENCES transcription_tasks(id) ON DELETE CASCADE,
    raw_transcription TEXT,
    processed_transcription TEXT,
    word_count INTEGER,
    confidence_score FLOAT,
    speakers_detected INTEGER,
    processing_time_seconds FLOAT,
    langchain_metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Progress logs table (for detailed tracking)
CREATE TABLE progress_logs (
    id SERIAL PRIMARY KEY,
    task_id UUID REFERENCES transcription_tasks(id) ON DELETE CASCADE,
    step_name VARCHAR(100),
    step_status VARCHAR(20),
    message TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    INDEX idx_task_created (task_id, created_at)
);
```

### Redis Data Structure

```python
# Task progress cache
redis_key = f"task:progress:{task_id}"
redis_data = {
    "status": "processing",
    "progress": 45,
    "current_step": "Transcribing chunk 3 of 7",
    "updated_at": "2025-01-08T10:30:00Z"
}
# TTL: 5 minutes

# Rate limiting
redis_key = f"upload:ratelimit:{ip_address}"
# Increment counter, expire in 1 hour

# Task queue results
redis_key = f"celery-task-meta-{celery_task_id}"
```

## API Design

### RESTful Endpoints

```yaml
/api/v1/:
  /upload:
    POST:
      description: Upload MP4 file for transcription
      request:
        content-type: multipart/form-data
        fields:
          - file: binary (required)
          - email: string (required)
      response:
        201:
          task_id: uuid
          status: "queued"
          progress_url: string

  /tasks/{task_id}:
    GET:
      description: Get task details
      response:
        200:
          id: uuid
          status: string
          progress: integer
          current_step: string
          created_at: datetime
          result_url: string (if completed)

  /tasks/{task_id}/progress:
    GET:
      description: Get real-time progress
      response:
        200:
          progress: integer
          current_step: string
          estimated_time_remaining: integer

  /tasks/{task_id}/result:
    GET:
      description: Get transcription result
      response:
        200:
          transcription: string
          word_count: integer
          confidence: float
          download_url: string

  /tasks/search:
    POST:
      description: Search for task by ID
      request:
        task_id: uuid
      response:
        200: Task object or 404
```

## Security Architecture

### Authentication & Authorization
- No user authentication required (per requirements)
- Task access via UUID (unguessable)
- Rate limiting on upload endpoint
- CORS configuration for frontend origin

### File Security
```python
# File validation
ALLOWED_EXTENSIONS = ['.mp4', '.m4a', '.mov']
MAX_FILE_SIZE = 500 * 1024 * 1024  # 500MB

# Secure file storage
MEDIA_ROOT = '/app/media/uploads/'
# Files stored with UUID names, original name in DB

# Temporary file cleanup
# Celery beat task to delete processed files after 7 days
```

### API Security
```python
# Rate limiting
from django_ratelimit.decorators import ratelimit

@ratelimit(key='ip', rate='10/h', method='POST')
def upload_file(request):
    pass

# Input validation with DRF serializers
class UploadSerializer(serializers.Serializer):
    file = serializers.FileField(max_length=255, allow_empty_file=False)
    email = serializers.EmailField()

    def validate_file(self, value):
        if value.size > MAX_FILE_SIZE:
            raise serializers.ValidationError("File too large")
        return value
```

## Performance Optimization Strategy

### Caching Strategy
```python
# Django cache configuration
CACHES = {
    'default': {
        'BACKEND': 'django_redis.cache.RedisCache',
        'LOCATION': 'redis://redis:6379/1',
        'OPTIONS': {
            'CLIENT_CLASS': 'django_redis.client.DefaultClient',
        },
        'KEY_PREFIX': 'transcripto',
        'TIMEOUT': 300,  # 5 minutes default
    }
}

# Cache usage
from django.core.cache import cache

def get_task_progress(task_id):
    cache_key = f"progress:{task_id}"
    progress = cache.get(cache_key)
    if not progress:
        progress = Task.objects.get(id=task_id).progress
        cache.set(cache_key, progress, timeout=30)
    return progress
```

### Async Processing
```python
# Celery configuration for optimal performance
CELERY_WORKER_PREFETCH_MULTIPLIER = 1
CELERY_TASK_ACKS_LATE = True
CELERY_TASK_REJECT_ON_WORKER_LOST = True

# Parallel chunk processing
from celery import group

def process_audio_chunks(chunks):
    job = group(
        transcribe_chunk.s(chunk_data)
        for chunk_data in chunks
    )
    result = job.apply_async()
    return result
```

### Database Optimization
```python
# Django ORM optimizations
class TaskViewSet(viewsets.ModelViewSet):
    queryset = Task.objects.select_related('result').prefetch_related('progress_logs')

# Connection pooling
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'CONN_MAX_AGE': 600,  # 10 minutes
        'OPTIONS': {
            'connect_timeout': 10,
        }
    }
}
```

## Scalability Considerations

### Horizontal Scaling
- **Celery Workers**: Can scale to multiple machines
- **Django Instances**: Load balanced behind NGINX
- **Redis Cluster**: For high availability
- **PostgreSQL**: Read replicas for queries

### Resource Limits
```yaml
# Docker resource constraints
services:
  celery:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G
```

### Monitoring & Observability
```python
# Celery Flower for task monitoring
celery -A core flower --port=5555

# Django logging
LOGGING = {
    'version': 1,
    'handlers': {
        'file': {
            'level': 'INFO',
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': '/var/log/transcripto/app.log',
            'maxBytes': 10485760,  # 10MB
            'backupCount': 5,
        },
    },
    'loggers': {
        'django': {
            'handlers': ['file'],
            'level': 'INFO',
        },
        'celery': {
            'handlers': ['file'],
            'level': 'INFO',
        },
    },
}

# Health check endpoints
def health_check(request):
    checks = {
        'database': check_database(),
        'redis': check_redis(),
        'celery': check_celery_workers(),
    }
    return JsonResponse(checks)
```

## Deployment Architecture

### Container Orchestration
```yaml
# Production deployment with docker-compose
version: '3.9'

services:
  # ... services configuration ...

  # Backup service
  backup:
    image: postgres:15-alpine
    command: >
      sh -c "while true; do
        pg_dump -h db -U postgres transcripto > /backups/backup_$$(date +%Y%m%d_%H%M%S).sql
        find /backups -name 'backup_*.sql' -mtime +7 -delete
        sleep 86400
      done"
    volumes:
      - ./backups:/backups

networks:
  transcripto:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/16
```

### Environment Configuration
```bash
# .env.production
DJANGO_SETTINGS_MODULE=core.settings.production
DEBUG=False
SECRET_KEY=<generated-secret-key>
DATABASE_URL=postgresql://user:pass@db:5432/transcripto
REDIS_URL=redis://redis:6379
GOOGLE_APPLICATION_CREDENTIALS=/app/credentials/gcloud-key.json
SENDGRID_API_KEY=<sendgrid-key>
NEXT_PUBLIC_API_URL=https://api.transcripto.com
ALLOWED_HOSTS=api.transcripto.com,transcripto.com
CORS_ALLOWED_ORIGINS=https://transcripto.com
```

## Development Workflow

### Local Development Setup
```bash
# Start all services
docker-compose up

# Run migrations
docker-compose exec backend python manage.py migrate

# Create superuser
docker-compose exec backend python manage.py createsuperuser

# Run tests
docker-compose exec backend pytest
docker-compose exec frontend npm test
```

### CI/CD Pipeline
```yaml
# .github/workflows/deploy.yml
name: Deploy Transcripto

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Run tests
        run: |
          docker-compose -f docker-compose.test.yml up --abort-on-container-exit

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to production
        run: |
          docker-compose -f docker-compose.prod.yml up -d
```