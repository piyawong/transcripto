from rest_framework import serializers
from apps.transcription.models import (
    TranscriptionTask,
    TranscriptionResult,
    TranscriptionChunk
)


class ChunkInfoSerializer(serializers.Serializer):
    """Serializer for chunk info when creating a task."""

    chunk_index = serializers.IntegerField(min_value=0)
    start_time_ms = serializers.IntegerField(min_value=0)
    end_time_ms = serializers.IntegerField(min_value=0)
    duration_ms = serializers.IntegerField(min_value=0)


class TaskCreateSerializer(serializers.ModelSerializer):
    """Serializer for creating a task with chunk support."""

    total_chunks = serializers.IntegerField(min_value=1, default=1)
    chunks_info = ChunkInfoSerializer(many=True, required=False, write_only=True)

    class Meta:
        model = TranscriptionTask
        fields = [
            'email',
            'original_filename',
            'file_size_bytes',
            'duration_seconds',
            'total_chunks',
            'chunks_info'
        ]

    def create(self, validated_data):
        """Create task and initialize chunk records."""
        chunks_info = validated_data.pop('chunks_info', [])
        task = TranscriptionTask.objects.create(**validated_data)

        # Create chunk records if provided
        for chunk_data in chunks_info:
            TranscriptionChunk.objects.create(
                task=task,
                chunk_index=chunk_data['chunk_index'],
                start_time_ms=chunk_data['start_time_ms'],
                end_time_ms=chunk_data['end_time_ms'],
                duration_ms=chunk_data['duration_ms'],
                status='pending'
            )

        return task


class SignedUrlSerializer(serializers.Serializer):
    """Request serializer for getting a signed upload URL (supports chunks)."""

    task_id = serializers.UUIDField(required=False)  # Required for chunk uploads
    chunk_index = serializers.IntegerField(min_value=0, required=False)
    filename = serializers.CharField(max_length=255)
    file_size = serializers.IntegerField(min_value=1)
    duration_seconds = serializers.IntegerField(min_value=1, required=False)


class ChunkUploadedSerializer(serializers.Serializer):
    """Serializer for notifying chunk upload completion."""

    chunk_index = serializers.IntegerField(min_value=0)
    gcs_uri = serializers.CharField(max_length=500)
    file_size_bytes = serializers.IntegerField(min_value=1)

    def validate_gcs_uri(self, value):
        """Validate GCS URI format."""
        if not value.startswith('gs://'):
            raise serializers.ValidationError("Invalid GCS URI format")
        return value


class ChunkSerializer(serializers.ModelSerializer):
    """Serializer for chunk details."""

    class Meta:
        model = TranscriptionChunk
        fields = [
            'id',
            'chunk_index',
            'status',
            'gcs_uri',
            'start_time_ms',
            'end_time_ms',
            'duration_ms',
            'file_size_bytes',
            'confidence_score',
            'speakers_detected',
            'processing_time_seconds',
            'created_at',
            'completed_at',
            'error_message'
        ]


class TaskSerializer(serializers.ModelSerializer):
    """Serializer for task list and basic details."""

    class Meta:
        model = TranscriptionTask
        fields = [
            'id',
            'status',
            'original_filename',
            'progress_percentage',
            'current_step',
            'created_at',
            'completed_at'
        ]


class TaskDetailSerializer(serializers.ModelSerializer):
    """Serializer for detailed task information with chunks."""

    result = serializers.SerializerMethodField()
    chunks = ChunkSerializer(many=True, read_only=True)

    class Meta:
        model = TranscriptionTask
        fields = [
            'id',
            'status',
            'email',
            'original_filename',
            'file_size_bytes',
            'duration_seconds',
            'progress_percentage',
            'current_step',
            'total_chunks',
            'chunks_uploaded',
            'chunks_processed',
            'created_at',
            'started_at',
            'completed_at',
            'error_message',
            'chunks',
            'result'
        ]

    def get_result(self, obj):
        """Include result if task is completed."""
        if hasattr(obj, 'result'):
            return ResultSerializer(obj.result).data
        return None


class ResultSerializer(serializers.ModelSerializer):
    """Serializer for transcription results."""

    class Meta:
        model = TranscriptionResult
        fields = [
            'processed_transcription',
            'word_count',
            'confidence_score',
            'speakers_detected',
            'processing_time_seconds',
            'langchain_metadata'
        ]