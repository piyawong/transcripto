from django.apps import AppConfig


class CommonConfig(AppConfig):
    """Configuration for the common utilities app."""

    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.common'
    verbose_name = 'Common Utilities'