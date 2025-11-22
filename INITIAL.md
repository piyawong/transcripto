## FEATURE: Transcripto - Audio Transcription Web Application

- Full-stack application with Next.js frontend and Django backend
- Audio transcription service using Google Cloud Speech-to-Text API
- MP4 file upload with automatic conversion to WAV format and batch processing
- Django backend with task tracking and progress monitoring
- Google Cloud integration for voice-to-text transcription
- LangChain-powered text processing and formatting
- Email notification system with progress tracking links
- No authentication required - task-based tracking via unique IDs
- Dockerized with docker-compose for one-command deployment

## EXAMPLES:

In the `examples/` folder, there will be reference implementations:

- `examples/backend/` - Django server setup with transcription tools
  - `models.py` - Django models for task tracking and progress
  - `views.py` - API endpoints for file upload and progress checking
  - `tasks.py` - Celery tasks for background transcription processing
  - `gcloud_client.py` - Google Cloud Speech-to-Text integration
  - `transcription_service.py` - Audio processing and batch management
- `examples/frontend/` - Next.js upload and progress interface
  - `components/FileUpload.tsx` - MP4 file upload component
  - `components/ProgressTracker.tsx` - Real-time progress monitoring
  - `components/SearchTask.tsx` - Task search by ID component
- `examples/audio_processing/` - Audio conversion and batch utilities
  - `audio_converter.py` - MP4 to WAV conversion
  - `batch_processor.py` - Audio file batching logic
- `examples/email_service/` - Email notification system
  - `email_sender.py` - Email templates and sending logic
  - `progress_links.py` - Progress tracking link generation

## DOCUMENTATION:

- Django documentation: https://docs.djangoproject.com/
- Google Cloud Speech-to-Text: https://cloud.google.com/speech-to-text/docs
- Next.js documentation: https://nextjs.org/docs
- LangChain documentation: https://python.langchain.com/docs/get_started/introduction
- Celery documentation: https://docs.celeryq.dev/
- Google Cloud Python Client: https://googleapis.dev/python/speech/latest/index.html
- Audio processing with Python: https://librosa.org/doc/latest/index.html
- Docker best practices: https://docs.docker.com/develop/dev-best-practices/
- Next.js Production Deployment: https://nextjs.org/docs/deployment

## CODE BEST PRACTICES:

### Backend (Django + Google Cloud):

- **Project Structure**: Follow Django best practices with apps for transcription, tasks, and email
- **API Design**: RESTful endpoints with proper HTTP status codes and progress responses
- **Async Processing**: Use Celery for background transcription tasks
- **Dependency Injection**: Utilize Django's built-in dependency management
- **Data Validation**: Django forms and serializers for all request/response schemas
- **Error Handling**: Global exception handlers with proper logging
- **Security**: File upload validation, rate limiting, secure file handling
- **Testing**: Django test framework with pytest-django, minimum 80% coverage
- **Logging**: Structured logging with appropriate log levels
- **Code Style**: Black formatter, pylint, type hints everywhere
- **Google Cloud**: Proper authentication, error handling, and retry logic

### Frontend (Next.js):

- **App Router**: Use Next.js 14+ App Router with Server Components
- **TypeScript**: Strict mode with proper type definitions
- **Component Design**: Atomic design pattern (atoms, molecules, organisms)
- **State Management**: Zustand or React Context for global state
- **Data Fetching**: Server Components for initial data, SWR/React Query for client
- **Styling**: Tailwind CSS with component library (shadcn/ui recommended)
- **Performance**: File upload optimization, progress indicators, real-time updates
- **SEO**: Proper meta tags, structured data, sitemap
- **Testing**: Jest + React Testing Library for unit/integration tests
- **Code Style**: ESLint, Prettier, strict TypeScript config

### Audio Processing & Google Cloud:

- **Audio Conversion**: Efficient MP4 to WAV conversion with proper quality settings
- **Batch Processing**: Optimal batch sizes for Google Cloud API limits
- **Progress Tracking**: Real-time progress updates for each batch
- **Error Handling**: Graceful handling of transcription failures
- **Rate Limiting**: Respect Google Cloud API quotas and limits
- **File Management**: Secure temporary file handling and cleanup

### Email & Progress Tracking:

- **Email Templates**: Professional email templates with progress links
- **Task IDs**: Secure, unique task identifiers for progress tracking
- **Progress Updates**: Real-time status updates via API
- **Search Functionality**: Efficient task search by ID
- **Security**: No authentication required but secure task access

### Docker & Deployment:

- **Multi-stage builds**: Optimize image size with multi-stage Dockerfiles
- **Layer caching**: Order Dockerfile commands for optimal caching
- **Health checks**: Implement health check endpoints and Docker HEALTHCHECK
- **Environment variables**: Use .env files with docker-compose override
- **Networking**: Proper service discovery within docker-compose
- **Volumes**: Persist data, logs, and temporary audio files
- **Security**: Non-root users, minimal base images (alpine/distroless)

## OTHER CONSIDERATIONS:

- **Docker-compose setup**: Single `docker-compose up` command to run entire stack
- **Development vs Production**: Separate docker-compose files for dev/prod
- **Hot reloading**: Enable for both frontend and backend in development
- Include a `.env.example` with required API keys (Google Cloud, email service)
- README with detailed setup instructions including Docker commands
- Project structure should clearly separate frontend, backend, and infrastructure
- Use `python-dotenv` and `load_dotenv()` for environment variables
- Backend should use `pip` or `poetry` for Python dependency management
- Include CORS configuration for Django to allow Next.js frontend connections
- Audio files should be processed in secure temporary directories
- Include sample MP4 files for testing the transcription pipeline
- Task progress should be maintained in Django database with Redis for caching
- Implement request/response caching for progress queries
- Add monitoring with OpenTelemetry or similar
- Include CI/CD pipeline configuration (GitHub Actions)
- Database migrations with Django's built-in migration system
- API documentation with Django REST framework auto-generation
- WebSocket support for real-time progress updates
- Graceful shutdown handling for all services
- Comprehensive error boundaries in React components
- Implement retry logic for failed Google Cloud API calls
- Add request ID tracking for debugging
- Include performance benchmarks and load testing scripts
- Audio file size limits and validation
- Progress persistence across server restarts
- Email delivery confirmation and tracking
- Batch processing optimization for large files
- Transcription quality monitoring and validation
