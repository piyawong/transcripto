from django.apps import AppConfig


class TranscriptionConfig(AppConfig):
    """Configuration for the transcription app."""

    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.transcription'
    verbose_name = 'Transcription'