import uuid
from django.db import models


class TranscriptionTask(models.Model):
    """
    Model representing a transcription task.

    Tracks the complete lifecycle of an audio transcription job from upload
    through processing to completion or failure. Supports frontend chunking
    where audio is split into chunks before upload.
    """

    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('uploading', 'Uploading Chunks'),
        ('processing', 'Processing'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending')
    email = models.EmailField()
    original_filename = models.CharField(max_length=255)
    gcs_uri = models.CharField(max_length=500, blank=True)  # Base GCS path for chunks
    file_size_bytes = models.BigIntegerField()
    duration_seconds = models.IntegerField(null=True, blank=True)
    progress_percentage = models.IntegerField(default=0)
    current_step = models.CharField(max_length=100, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    error_message = models.TextField(blank=True)

    # New fields for frontend chunking support
    total_chunks = models.IntegerField(default=1)
    chunks_uploaded = models.IntegerField(default=0)
    chunks_processed = models.IntegerField(default=0)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['status', 'created_at']),
            models.Index(fields=['email']),
        ]

    def __str__(self):
        return f"{self.original_filename} - {self.status}"


class TranscriptionChunk(models.Model):
    """
    Model representing a single chunk of audio for transcription.

    Each chunk is uploaded separately from the frontend and processed
    independently by Celery workers for parallel processing.
    """

    STATUS_CHOICES = [
        ('pending', 'Pending Upload'),
        ('uploaded', 'Uploaded'),
        ('processing', 'Processing'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(
        TranscriptionTask,
        on_delete=models.CASCADE,
        related_name='chunks'
    )
    chunk_index = models.IntegerField()  # 0-based index
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending')
    gcs_uri = models.CharField(max_length=500, blank=True)
    start_time_ms = models.IntegerField()  # Start time in milliseconds
    end_time_ms = models.IntegerField()  # End time in milliseconds
    duration_ms = models.IntegerField()  # Duration in milliseconds
    file_size_bytes = models.BigIntegerField(default=0)

    # Transcription results for this chunk
    raw_transcription = models.TextField(blank=True)
    confidence_score = models.FloatField(null=True, blank=True)
    speakers_detected = models.IntegerField(default=0)
    processing_time_seconds = models.FloatField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    error_message = models.TextField(blank=True)

    class Meta:
        ordering = ['task', 'chunk_index']
        unique_together = ['task', 'chunk_index']
        indexes = [
            models.Index(fields=['task', 'status']),
        ]

    def __str__(self):
        return f"Chunk {self.chunk_index} of {self.task.id}"


class TranscriptionResult(models.Model):
    """
    Model storing the final combined transcription results and metadata.

    Contains both the raw and processed transcription text along with
    metadata about the transcription quality and processing details.
    """

    task = models.OneToOneField(
        TranscriptionTask,
        on_delete=models.CASCADE,
        related_name='result'
    )
    raw_transcription = models.TextField()
    processed_transcription = models.TextField()
    word_count = models.IntegerField()
    confidence_score = models.FloatField()
    speakers_detected = models.IntegerField(default=0)
    processing_time_seconds = models.FloatField()
    langchain_metadata = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"Result for {self.task.id}"