from django.contrib import admin
from .models import TranscriptionTask, TranscriptionResult


@admin.register(TranscriptionTask)
class TranscriptionTaskAdmin(admin.ModelAdmin):
    list_display = [
        'id',
        'original_filename',
        'status',
        'email',
        'progress_percentage',
        'created_at',
        'completed_at'
    ]
    list_filter = ['status', 'created_at']
    search_fields = ['id', 'email', 'original_filename']
    readonly_fields = ['id', 'created_at', 'started_at', 'completed_at']


@admin.register(TranscriptionResult)
class TranscriptionResultAdmin(admin.ModelAdmin):
    list_display = [
        'task',
        'word_count',
        'confidence_score',
        'speakers_detected',
        'processing_time_seconds',
        'created_at'
    ]
    list_filter = ['created_at']
    search_fields = ['task__id', 'task__email']
    readonly_fields = ['created_at']