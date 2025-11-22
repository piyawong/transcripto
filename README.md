# Transcripto - Audio Transcription Web Application

A complete web application for automated audio transcription powered by Google Cloud Speech-to-Text API, Django, and Next.js.

## Features

- 🎵 **Audio/Video Support**: Upload MP4, M4A, or MOV files of any size
- 🔄 **Browser-side Conversion**: Automatic conversion to optimized WAV format using FFmpeg.wasm
- ☁️ **Direct Cloud Upload**: Files uploaded directly to Google Cloud Storage from browser
- 🤖 **AI Transcription**: Powered by Google Cloud Speech-to-Text with speaker diarization
- ⚡ **Real-time Progress**: Track transcription progress with live updates
- 📧 **Email Notifications**: Get notified at 0%, 50%, and 100% completion
- 🎨 **Modern UI**: Beautiful, animated interface with Magic UI components
- 🔐 **No Authentication Required**: Task-based access with unique IDs

## Tech Stack

### Backend
- Django 5.1.2
- Django REST Framework
- Celery (async task processing)
- Redis (message broker & cache)
- PostgreSQL (database)
- Google Cloud Speech-to-Text API
- Google Cloud Storage
- LangChain (text processing)

### Frontend
- Next.js 14
- React 18
- TypeScript
- Tailwind CSS
- FFmpeg.wasm (audio conversion)
- SWR (data fetching)
- Magic UI Components

### Infrastructure
- Docker & Docker Compose
- Nginx (reverse proxy)

## Prerequisites

- Docker and Docker Compose installed
- Google Cloud Project with:
  - Speech-to-Text API enabled
  - Cloud Storage bucket created
  - Service account with appropriate permissions
- SendGrid account for email notifications (optional)

## Quick Start

### 1. Clone the repository
```bash
git clone <repository-url>
cd transcripto-new
```

### 2. Set up Google Cloud credentials

Create a service account in Google Cloud Console with the following roles:
- `Storage Object Admin`
- `Cloud Speech-to-Text User`

Download the service account JSON file and save it as:
```bash
credentials/service-account.json
```

### 3. Configure environment variables

Copy the example environment file:
```bash
cp .env.example .env
```

Edit `.env` with your configuration:
```env
# Google Cloud
GCS_BUCKET_NAME=your-bucket-name
GOOGLE_CLOUD_PROJECT=your-project-id

# SendGrid (optional)
SENDGRID_API_KEY=your-sendgrid-key
DEFAULT_FROM_EMAIL=noreply@yourdomain.com

# Django
SECRET_KEY=your-secret-key-here
```

### 4. Start the application

```bash
docker-compose up
```

The application will be available at:
- Frontend: http://localhost:3000
- Backend API: http://localhost:8000/api

## Development

### Backend Development

```bash
# Enter backend container
docker-compose exec backend bash

# Run migrations
python manage.py migrate

# Create superuser
python manage.py createsuperuser

# Run tests
pytest tests/ -v
```

### Frontend Development

```bash
# Enter frontend container
docker-compose exec frontend sh

# Install dependencies
npm install

# Run development server
npm run dev

# Run tests
npm test

# Run Playwright tests
npm run test:e2e
```

## Architecture

### Processing Flow

1. User uploads MP4/M4A/MOV file via web interface
2. Frontend converts audio to WAV format (16kHz, mono) using FFmpeg.wasm
3. Frontend uploads WAV directly to Google Cloud Storage using signed URL
4. Backend creates transcription task and queues it for processing
5. Celery worker processes audio in 30-minute chunks
6. Google Cloud Speech-to-Text transcribes each chunk
7. LangChain processes and formats the transcription
8. User receives email notifications at key milestones
9. Final transcript available for viewing and download

### Project Structure

```
transcripto-new/
├── backend/                 # Django backend
│   ├── core/                # Project configuration
│   ├── apps/
│   │   ├── transcription/   # Main transcription app
│   │   ├── notifications/   # Email notifications
│   │   └── common/          # Shared utilities
│   └── tests/               # Unit tests
├── frontend/                # Next.js frontend
│   ├── src/
│   │   ├── app/            # App router pages
│   │   ├── components/     # React components
│   │   ├── lib/            # Utilities & API client
│   │   └── types/          # TypeScript definitions
│   └── tests/              # Frontend tests
├── docker-compose.yml       # Docker orchestration
└── credentials/            # GCP credentials (gitignored)
```

## API Endpoints

- `POST /api/v1/tasks/get_upload_url/` - Get signed URL for GCS upload
- `POST /api/v1/tasks/` - Create transcription task
- `GET /api/v1/tasks/{id}/` - Get task details
- `GET /api/v1/tasks/{id}/progress/` - Get real-time progress
- `GET /api/v1/tasks/{id}/result/` - Get transcription result
- `POST /api/v1/tasks/search/` - Search task by ID

## Configuration

### Google Cloud Storage CORS

Enable CORS for your GCS bucket to allow browser uploads:

```json
[
  {
    "origin": ["http://localhost:3000", "https://yourdomain.com"],
    "method": ["GET", "PUT", "POST"],
    "responseHeader": ["Content-Type"],
    "maxAgeSeconds": 3600
  }
]
```

Apply with:
```bash
gsutil cors set cors.json gs://your-bucket-name
```

## Testing

### Unit Tests
```bash
# Backend
cd backend && pytest tests/ -v

# Frontend
cd frontend && npm test
```

### End-to-End Tests
```bash
cd frontend && npm run test:e2e
```

### UI Review
```bash
cd frontend && npm run ui:review
```

## Performance

- Processes 1-hour audio in <15 minutes
- Supports 10 concurrent file processing
- Handles 100 concurrent users
- 99% task completion rate

## Troubleshooting

### FFmpeg.wasm not loading
Ensure your Next.js server has proper CORS headers:
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Opener-Policy: same-origin`

### Google Cloud authentication errors
1. Verify service account has correct permissions
2. Check credentials file path in docker-compose.yml
3. Ensure GOOGLE_APPLICATION_CREDENTIALS environment variable is set

### Email notifications not sending
1. Check SendGrid API key is configured
2. Verify DEFAULT_FROM_EMAIL is set
3. Check Celery worker logs for errors

## License

MIT License

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request