# User Clarifications - Transcripto

## Project Requirements Review

Based on the INITIAL.md file, the requirements are comprehensive and clear. The following assumptions have been made:

## Assumptions & Clarifications

### 1. File Processing
- **Assumption**: MP4 files will contain audio tracks (not video-only files)
- **Assumption**: Maximum file size limit of 500MB is reasonable for web uploads
- **Assumption**: Temporary storage for processing will be managed in Docker volumes

### 2. Task Tracking
- **Assumption**: Task IDs will be UUIDs for security through obscurity
- **Assumption**: Tasks and their results will be retained for 30 days before automatic cleanup
- **Assumption**: No user accounts means anyone with the task ID can view the results

### 3. Email Notifications
- **Assumption**: Email is required at upload time
- **Assumption**: Email notifications will include:
  - Initial confirmation with task ID
  - Progress update at 50% completion
  - Final notification with download link
- **Assumption**: No email verification required (simplified flow)

### 4. Google Cloud Integration
- **Assumption**: Service account credentials will be provided via environment variable
- **Assumption**: Using standard tier Speech-to-Text API (not enhanced models)
- **Assumption**: English language transcription only initially

### 5. Progress Tracking
- **Assumption**: Progress updates every 5-10 seconds are sufficient
- **Assumption**: Progress percentage based on audio chunks processed
- **Assumption**: WebSocket support is optional (polling is acceptable)

### 6. Text Processing with LangChain
- **Assumption**: Basic text cleanup includes:
  - Removing filler words
  - Fixing punctuation
  - Paragraph formatting
  - Capitalization corrections
- **Assumption**: No advanced NLP features required initially

### 7. Docker Deployment
- **Assumption**: Development and production configurations separated
- **Assumption**: All services run in containers (no hybrid deployments)
- **Assumption**: Persistent volumes for database and media files

### 8. Frontend Features
- **Assumption**: Responsive design for mobile and desktop
- **Assumption**: Modern browser support only (Chrome, Firefox, Safari, Edge latest versions)
- **Assumption**: No IE11 support required

### 9. API Design
- **Assumption**: RESTful API with JSON responses
- **Assumption**: No GraphQL or WebSocket requirements for MVP
- **Assumption**: Rate limiting of 10 uploads per hour per IP

### 10. Performance Requirements
- **Assumption**: Support for concurrent processing of 10 files
- **Assumption**: Transcription of 1-hour audio should complete within 15 minutes
- **Assumption**: System should handle 100 concurrent users

## Questions for Future Clarification

1. **Multi-language Support**: Will the system need to support languages other than English?
2. **Audio Quality**: Should we implement quality checks for uploaded audio?
3. **Export Formats**: Besides viewing online, should users be able to download transcriptions in specific formats (PDF, DOCX, SRT)?
4. **Analytics**: Do we need to track usage metrics or provide admin dashboards?
5. **Backup Strategy**: What's the preferred backup frequency and retention policy?
6. **Custom Vocabulary**: Should users be able to provide industry-specific terms for better transcription accuracy?
7. **Batch Upload**: Should users be able to upload multiple files at once?
8. **API Access**: Should we provide API keys for programmatic access in the future?

## Design Decisions Made

1. **Database**: PostgreSQL chosen over MongoDB for ACID compliance and Django ORM compatibility
2. **Message Broker**: Redis chosen over RabbitMQ for simplicity and caching dual-purpose
3. **File Storage**: Local Docker volumes initially, can migrate to S3/GCS later
4. **Frontend Framework**: Next.js App Router over Pages Router for better performance
5. **CSS Framework**: Tailwind CSS with shadcn/ui for rapid development
6. **Testing**: Pytest for backend, Jest for frontend
7. **Monitoring**: Celery Flower for task monitoring, can add Sentry later
8. **Load Balancer**: NGINX for reverse proxy and static file serving

## Out of Scope for MVP

1. User authentication and accounts
2. Real-time collaborative features
3. Advanced audio editing or preview
4. Machine learning model fine-tuning
5. On-premise deployment options
6. Mobile applications (iOS/Android)
7. Webhook integrations for third-party services
8. Advanced analytics and reporting dashboards

## Success Criteria

1. **Functional**: Successfully transcribe MP4 files to text
2. **Performance**: Process 1-hour audio in under 15 minutes
3. **Reliability**: 99% task completion rate
4. **Usability**: Simple 3-step process (upload → track → view)
5. **Scalability**: Handle 100 concurrent users
6. **Maintainability**: Comprehensive test coverage (>80%)
7. **Deployment**: One-command Docker deployment