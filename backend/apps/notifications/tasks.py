import logging
import os
from celery import shared_task
from django.template.loader import render_to_string
from django.core.mail import send_mail
from django.conf import settings

from apps.transcription.models import TranscriptionTask

logger = logging.getLogger(__name__)


@shared_task
def send_notification_email(task_id: str, notification_type: str) -> bool:
    """
    Send email notifications for transcription task events.

    Args:
        task_id: UUID of the TranscriptionTask
        notification_type: Type of notification (started, halfway, completed, error)

    Returns:
        Boolean indicating success
    """
    try:
        task = TranscriptionTask.objects.get(id=task_id)

        # Determine email subject and template based on notification type
        subject_map = {
            "started": f"Transcription Started: {task.original_filename}",
            "halfway": f"Transcription 50% Complete: {task.original_filename}",
            "completed": f"Transcription Completed: {task.original_filename}",
            "error": f"Transcription Failed: {task.original_filename}",
        }

        template_map = {
            "started": "emails/task_started.html",
            "halfway": "emails/progress_update.html",
            "completed": "emails/task_completed.html",
            "error": "emails/task_error.html",
        }

        subject = subject_map.get(notification_type, "Transcription Update")
        template = template_map.get(notification_type, "emails/task_update.html")

        # Prepare context for email template
        context = {
            "task": task,
            "task_id": str(task.id),
            "filename": task.original_filename,
            "status": task.status,
            "progress": task.progress_percentage,
            "current_step": task.current_step,
            "view_url": f"{os.environ.get('FRONTEND_URL', 'http://localhost:3000')}/progress/{task.id}",
            "result_url": f"{os.environ.get('FRONTEND_URL', 'http://localhost:3000')}/result/{task.id}",
        }

        # Render email HTML
        html_content = render_to_string(template, context)

        # Send email
        send_mail(
            subject=subject,
            message="",  # Plain text version (empty as we're using HTML)
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[task.email],
            html_message=html_content,
            fail_silently=False,
        )

        logger.info(f"Sent {notification_type} email for task {task_id}")
        return True

    except TranscriptionTask.DoesNotExist:
        logger.error(f"Task {task_id} not found for email notification")
        return False
    except Exception as e:
        logger.error(f"Failed to send email for task {task_id}: {e}")
        return False