from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.parsers import MultiPartParser, FormParser
from django.core.cache import cache
from django_ratelimit.decorators import ratelimit
from django.utils.decorators import method_decorator
from django.db import transaction

from apps.transcription.models import TranscriptionTask, TranscriptionChunk
from apps.transcription.serializers import (
    TaskCreateSerializer,
    TaskSerializer,
    TaskDetailSerializer,
    SignedUrlSerializer,
    ResultSerializer,
    ChunkUploadedSerializer,
    ChunkSerializer
)
from apps.transcription.tasks import (
    process_transcription_task,
    process_chunk_task,
    combine_chunks_task
)
from apps.transcription.services.gcs_service import GCSService
from apps.notifications.tasks import send_notification_email


class TaskViewSet(viewsets.ModelViewSet):
    """
    ViewSet for managing transcription tasks.

    Provides endpoints for task creation, progress tracking,
    result retrieval, and search functionality.
    """

    queryset = TranscriptionTask.objects.all()
    serializer_class = TaskSerializer

    @action(detail=False, methods=['post'])
    def get_upload_url(self, request):
        """
        Generate a signed URL for direct GCS upload from browser.

        Supports both single file uploads and chunked uploads.

        Expects:
            - filename: Name of the file to upload
            - file_size: Size of the file in bytes
            - task_id: (optional) Task ID for chunked uploads
            - chunk_index: (optional) Chunk index for chunked uploads

        Returns:
            - upload_url: Signed URL for PUT upload
            - gcs_uri: GCS URI for the uploaded file
            - blob_name: Blob name in the bucket
        """
        serializer = SignedUrlSerializer(data=request.data)
        if serializer.is_valid():
            data = serializer.validated_data
            gcs_service = GCSService()

            # Check if this is a chunk upload
            task_id = data.get('task_id')
            chunk_index = data.get('chunk_index')

            if task_id and chunk_index is not None:
                # Chunk upload: use task_id/chunk_{index}.wav format
                blob_name = f"{task_id}/chunk_{chunk_index}.wav"
            else:
                # Regular upload: use timestamp-based name
                blob_name = None

            upload_info = gcs_service.generate_upload_signed_url(
                data['filename'],
                blob_name=blob_name
            )

            return Response({
                'upload_url': upload_info['upload_url'],
                'gcs_uri': upload_info['gcs_uri'],
                'blob_name': upload_info['blob_name']
            })

        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    @method_decorator(ratelimit(key='ip', rate='10/h', method='POST'))
    def create(self, request):
        """
        Create transcription task after frontend uploads to GCS.

        For chunked uploads (chunks_info provided):
        - Creates task and chunk records
        - Does NOT start processing - waits for chunk_uploaded calls

        For legacy single-file uploads (no chunks_info):
        - Creates task and starts processing immediately

        Rate limited to 10 tasks per hour per IP address.
        """
        serializer = TaskCreateSerializer(data=request.data)
        if serializer.is_valid():
            task = serializer.save()

            # Check if this is a chunked upload
            chunks_info = request.data.get('chunks_info', [])
            is_chunked = len(chunks_info) > 0

            # Send "started" email with tracking link immediately
            send_notification_email.delay(str(task.id), "started")

            if is_chunked:
                # Chunked upload: wait for chunks to be uploaded
                # Processing starts when chunk_uploaded is called for each chunk
                return Response({
                    'task_id': task.id,
                    'status': task.status,
                    'total_chunks': task.total_chunks,
                    'progress_url': f'/api/v1/tasks/{task.id}/progress/',
                    'message': 'Task created. Upload chunks to start processing.'
                }, status=status.HTTP_201_CREATED)
            else:
                # Legacy single-file upload: start processing immediately
                process_transcription_task.delay(str(task.id))

                return Response({
                    'task_id': task.id,
                    'status': task.status,
                    'progress_url': f'/api/v1/tasks/{task.id}/progress/',
                    'message': 'Transcription task created. Processing started.'
                }, status=status.HTTP_201_CREATED)

        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def retrieve(self, request, pk=None):
        """Get detailed task information."""
        try:
            task = TranscriptionTask.objects.get(id=pk)
            serializer = TaskDetailSerializer(task)
            return Response(serializer.data)
        except TranscriptionTask.DoesNotExist:
            return Response(
                {'error': 'Task not found'},
                status=status.HTTP_404_NOT_FOUND
            )

    @action(detail=True, methods=['get'])
    def progress(self, request, pk=None):
        """
        Get real-time progress for a task.

        Returns cached progress if available, otherwise fetches from database.
        """
        # Check cache first for real-time updates
        cache_key = f"progress:{pk}"
        cached_progress = cache.get(cache_key)

        if cached_progress:
            return Response(cached_progress)

        # Fallback to database
        try:
            task = TranscriptionTask.objects.get(id=pk)
            progress_data = {
                'progress': task.progress_percentage,
                'step': task.current_step,
                'status': task.status
            }

            # Cache for 30 seconds
            cache.set(cache_key, progress_data, timeout=30)
            return Response(progress_data)
        except TranscriptionTask.DoesNotExist:
            return Response(
                {'error': 'Task not found'},
                status=status.HTTP_404_NOT_FOUND
            )

    @action(detail=True, methods=['get'])
    def result(self, request, pk=None):
        """Get transcription result for a completed task."""
        try:
            task = TranscriptionTask.objects.get(id=pk)
            if task.status != 'completed':
                return Response(
                    {'error': f'Task is {task.status}, not completed'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            if hasattr(task, 'result'):
                serializer = ResultSerializer(task.result)
                return Response(serializer.data)

            return Response(
                {'error': 'Result not found'},
                status=status.HTTP_404_NOT_FOUND
            )
        except TranscriptionTask.DoesNotExist:
            return Response(
                {'error': 'Task not found'},
                status=status.HTTP_404_NOT_FOUND
            )

    @action(detail=True, methods=['post'])
    def chunk_uploaded(self, request, pk=None):
        """
        Notify that a chunk has been uploaded to GCS.

        Updates chunk status and triggers processing when all chunks are uploaded.

        Expects:
            - chunk_index: Index of the uploaded chunk
            - gcs_uri: GCS URI of the uploaded chunk
            - file_size_bytes: Size of the uploaded chunk
        """
        try:
            task = TranscriptionTask.objects.get(id=pk)
        except TranscriptionTask.DoesNotExist:
            return Response(
                {'error': 'Task not found'},
                status=status.HTTP_404_NOT_FOUND
            )

        serializer = ChunkUploadedSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        data = serializer.validated_data
        chunk_index = data['chunk_index']

        try:
            chunk = TranscriptionChunk.objects.get(
                task=task,
                chunk_index=chunk_index
            )
        except TranscriptionChunk.DoesNotExist:
            return Response(
                {'error': f'Chunk {chunk_index} not found'},
                status=status.HTTP_404_NOT_FOUND
            )

        # Update chunk with upload info
        with transaction.atomic():
            chunk.status = 'uploaded'
            chunk.gcs_uri = data['gcs_uri']
            chunk.file_size_bytes = data['file_size_bytes']
            chunk.save()

            # Update task chunk counter
            task.chunks_uploaded = TranscriptionChunk.objects.filter(
                task=task,
                status__in=['uploaded', 'processing', 'completed']
            ).count()

            # Update task status if this is the first chunk
            if task.status == 'pending':
                task.status = 'uploading'

            task.save()

        # Start processing this chunk immediately
        process_chunk_task.delay(str(task.id), chunk_index)

        # Check if all chunks are uploaded
        all_uploaded = task.chunks_uploaded >= task.total_chunks

        return Response({
            'message': f'Chunk {chunk_index} uploaded successfully',
            'chunk_status': chunk.status,
            'chunks_uploaded': task.chunks_uploaded,
            'total_chunks': task.total_chunks,
            'all_chunks_uploaded': all_uploaded,
            'processing_started': True
        })

    @action(detail=True, methods=['get'])
    def chunks_status(self, request, pk=None):
        """
        Get status of all chunks for a task.

        Returns detailed status of each chunk including processing progress.
        """
        try:
            task = TranscriptionTask.objects.get(id=pk)
        except TranscriptionTask.DoesNotExist:
            return Response(
                {'error': 'Task not found'},
                status=status.HTTP_404_NOT_FOUND
            )

        chunks = TranscriptionChunk.objects.filter(task=task).order_by('chunk_index')
        serializer = ChunkSerializer(chunks, many=True)

        return Response({
            'task_id': str(task.id),
            'task_status': task.status,
            'total_chunks': task.total_chunks,
            'chunks_uploaded': task.chunks_uploaded,
            'chunks_processed': task.chunks_processed,
            'chunks': serializer.data
        })

    @action(detail=False, methods=['post'])
    def search(self, request):
        """
        Search for a task by ID.

        No authentication required - anyone with the task ID can view it.
        """
        task_id = request.data.get('task_id')
        if not task_id:
            return Response(
                {'error': 'task_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            task = TranscriptionTask.objects.get(id=task_id)
            serializer = TaskDetailSerializer(task)
            return Response(serializer.data)
        except TranscriptionTask.DoesNotExist:
            return Response(
                {'error': 'Task not found'},
                status=status.HTTP_404_NOT_FOUND
            )