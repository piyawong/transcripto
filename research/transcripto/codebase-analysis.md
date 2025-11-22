# Codebase Analysis - Transcripto

## Current State
- **New Project**: Starting from scratch with requirements defined in INITIAL.md
- **No existing codebase** to analyze for patterns

## Recommended Project Structure

### Backend (Django)
```
backend/
├── manage.py
├── requirements.txt
├── .env.example
├── core/                     # Main Django project
│   ├── settings/
│   │   ├── base.py
│   │   ├── development.py
│   │   └── production.py
│   ├── urls.py
│   ├── wsgi.py
│   └── celery.py
├── apps/
│   ├── transcription/        # Main transcription app
│   │   ├── models.py        # Task, TranscriptionResult models
│   │   ├── serializers.py   # DRF serializers
│   │   ├── views.py         # API endpoints
│   │   ├── tasks.py         # Celery tasks
│   │   ├── services/
│   │   │   ├── gcloud_client.py
│   │   │   ├── audio_processor.py
│   │   │   └── text_processor.py
│   │   └── urls.py
│   ├── notifications/       # Email notification app
│   │   ├── models.py
│   │   ├── tasks.py
│   │   ├── services/
│   │   │   └── email_service.py
│   │   └── templates/
│   │       └── emails/
│   └── common/              # Shared utilities
│       └── utils.py
└── tests/
    ├── test_transcription/
    └── test_notifications/
```

### Frontend (Next.js)
```
frontend/
├── package.json
├── next.config.js
├── .env.example
├── public/
├── src/
│   ├── app/                 # App Router (Next.js 14+)
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── upload/
│   │   │   └── page.tsx
│   │   ├── progress/[taskId]/
│   │   │   └── page.tsx
│   │   └── api/            # API routes if needed
│   ├── components/
│   │   ├── FileUpload/
│   │   │   ├── FileUpload.tsx
│   │   │   └── FileUpload.module.css
│   │   ├── ProgressTracker/
│   │   │   └── ProgressTracker.tsx
│   │   └── SearchTask/
│   │       └── SearchTask.tsx
│   ├── lib/
│   │   ├── api.ts          # API client
│   │   └── utils.ts
│   ├── hooks/
│   │   └── useTaskProgress.ts
│   └── types/
│       └── index.ts
└── tests/
```

## Django Conventions to Follow

### Model Design Pattern
```python
from django.db import models
import uuid

class Task(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['status', 'created_at']),
        ]
```

### API View Pattern (Django REST Framework)
```python
from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response

class TaskViewSet(viewsets.ModelViewSet):
    serializer_class = TaskSerializer
    queryset = Task.objects.all()

    @action(detail=True, methods=['get'])
    def progress(self, request, pk=None):
        task = self.get_object()
        return Response(TaskProgressSerializer(task).data)
```

### Celery Task Pattern
```python
from celery import shared_task
from celery.utils.log import get_task_logger

logger = get_task_logger(__name__)

@shared_task(bind=True, max_retries=3)
def process_transcription(self, task_id):
    try:
        # Task logic
        pass
    except Exception as exc:
        logger.error(f"Task failed: {exc}")
        raise self.retry(exc=exc, countdown=60)
```

## Next.js Conventions to Follow

### Component Pattern (TypeScript)
```typescript
interface FileUploadProps {
  onUploadComplete: (taskId: string) => void;
  maxFileSize?: number;
}

export const FileUpload: React.FC<FileUploadProps> = ({
  onUploadComplete,
  maxFileSize = 100 * 1024 * 1024 // 100MB default
}) => {
  // Component logic
};
```

### API Client Pattern
```typescript
class ApiClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api';
  }

  async uploadFile(file: File): Promise<{ taskId: string }> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${this.baseUrl}/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error('Upload failed');
    }

    return response.json();
  }
}
```

## Testing Patterns

### Django Test Pattern
```python
from django.test import TestCase
from rest_framework.test import APITestCase

class TaskAPITestCase(APITestCase):
    def setUp(self):
        self.task = Task.objects.create(...)

    def test_upload_file(self):
        with open('test_file.mp4', 'rb') as f:
            response = self.client.post('/api/upload/', {'file': f})
        self.assertEqual(response.status_code, 201)
```

### Next.js Test Pattern
```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { FileUpload } from '@/components/FileUpload';

describe('FileUpload', () => {
  it('should handle file selection', () => {
    const mockCallback = jest.fn();
    render(<FileUpload onUploadComplete={mockCallback} />);
    // Test logic
  });
});
```

## Configuration Files to Create

1. **backend/requirements.txt**
   - Django==5.1.7
   - djangorestframework==3.15.0
   - celery==5.4.0
   - redis==5.2.1
   - google-cloud-speech==2.25.1
   - django-cors-headers==4.3.1
   - python-dotenv==1.0.0
   - langchain==0.1.0
   - sendgrid==6.10.0

2. **frontend/package.json dependencies**
   - next: ^14.0.0
   - react: ^18.3.0
   - typescript: ^5.0.0
   - @tanstack/react-query: ^5.0.0
   - zustand: ^4.4.0
   - tailwindcss: ^3.4.0
   - shadcn/ui components

3. **Docker configuration**
   - Dockerfile for backend (multi-stage)
   - Dockerfile for frontend (multi-stage)
   - docker-compose.yml (development)
   - docker-compose.prod.yml (production)