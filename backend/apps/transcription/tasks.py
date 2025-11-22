import logging
from celery import shared_task
from celery.utils.log import get_task_logger
from django.utils import timezone
from django.core.cache import cache
from typing import Any, Dict

from apps.transcription.models import (
    TranscriptionTask,
    TranscriptionResult,
    TranscriptionChunk
)
from apps.transcription.services.gcs_service import GCSService
from apps.transcription.services.gcloud_client import GoogleCloudSpeechClient
from apps.transcription.services.text_processor import TextProcessor

logger = get_task_logger(__name__)


@shared_task(bind=True, max_retries=3, default_retry_delay=60)
def process_transcription_task(self, task_id: str) -> Dict[str, Any]:
    """
    Main transcription pipeline for GCS-based audio files.

    Args:
        task_id: UUID of the TranscriptionTask

    Returns:
        Dict with task_id and completion status
    """
    try:
        # Initialize task
        task = TranscriptionTask.objects.get(id=task_id)
        task.status = "processing"
        task.started_at = timezone.now()
        task.save()

        # Import here to avoid circular dependency
        from apps.notifications.tasks import send_notification_email

        # Send start notification
        send_notification_email.delay(task_id, "started")

        # Step 1: Prepare chunks (10%)
        self.update_state(
            state='PROGRESS',
            meta={'progress': 10, 'step': 'Preparing audio chunks'}
        )
        task.current_step = "Preparing audio for processing"
        task.progress_percentage = 10
        task.save()
        cache.set(
            f"progress:{task_id}",
            {"progress": 10, "step": task.current_step},
            timeout=300
        )

        gcs_service = GCSService()

        # Split audio into 30-minute chunks for processing
        chunks = gcs_service.split_audio_into_chunks(
            task.gcs_uri,
            chunk_duration_ms=1800000  # 30 minutes
        )
        logger.info(f"Prepared {len(chunks)} chunks for processing")

        # Step 2: Transcribe chunks (20-80%)
        gcloud = GoogleCloudSpeechClient()
        transcriptions = []
        total_chunks = len(chunks)

        for i, chunk in enumerate(chunks):
            progress = 20 + int((i / total_chunks) * 60)
            self.update_state(
                state='PROGRESS',
                meta={
                    'progress': progress,
                    'step': f'Transcribing segment {i+1} of {total_chunks}'
                }
            )
            task.current_step = f"Transcribing segment {i+1}/{total_chunks}"
            task.progress_percentage = progress
            task.save()
            cache.set(
                f"progress:{task_id}",
                {"progress": progress, "step": task.current_step},
                timeout=300
            )

            # Send 50% notification
            if progress >= 50 and task.progress_percentage < 50:
                send_notification_email.delay(task_id, "halfway")

            try:
                # Transcribe directly from GCS with time bounds
                result = gcloud.transcribe_gcs_uri(
                    chunk['gcs_uri'],
                    start_time=chunk.get('start_time'),
                    end_time=chunk.get('end_time')
                )
                transcriptions.append(result)
                logger.info(
                    f"Transcribed segment {i+1}: {len(result['transcript'])} chars"
                )
            except Exception as e:
                logger.error(f"Segment {i} transcription failed: {e}")
                # Continue with other segments

        # Step 3: Combine results (85%)
        self.update_state(
            state='PROGRESS',
            meta={'progress': 85, 'step': 'Combining transcriptions'}
        )
        task.current_step = "Combining transcriptions"
        task.progress_percentage = 85
        task.save()
        cache.set(
            f"progress:{task_id}",
            {"progress": 85, "step": task.current_step},
            timeout=300
        )

        # Combine all transcriptions
        raw_transcript = " ".join([
            t["transcript"] for t in transcriptions
            if t.get("transcript")
        ])

        # Calculate average confidence
        confidence_scores = [t["confidence"] for t in transcriptions]
        avg_confidence = (
            sum(confidence_scores) / len(confidence_scores)
            if confidence_scores else 0
        )

        # Step 4: Process with LangChain (90%)
        self.update_state(
            state='PROGRESS',
            meta={'progress': 90, 'step': 'Formatting text'}
        )
        task.current_step = "Formatting text"
        task.progress_percentage = 90
        task.save()
        cache.set(
            f"progress:{task_id}",
            {"progress": 90, "step": task.current_step},
            timeout=300
        )

        text_processor = TextProcessor()
        processed_transcript = text_processor.clean_and_format(raw_transcript)
        metadata = text_processor.extract_metadata(processed_transcript)

        # Step 5: Save results (95%)
        self.update_state(
            state='PROGRESS',
            meta={'progress': 95, 'step': 'Saving results'}
        )
        task.current_step = "Saving results"
        task.progress_percentage = 95
        task.save()
        cache.set(
            f"progress:{task_id}",
            {"progress": 95, "step": task.current_step},
            timeout=300
        )

        # Calculate processing time
        processing_time = (timezone.now() - task.started_at).total_seconds()

        # Save transcription result
        result = TranscriptionResult.objects.create(
            task=task,
            raw_transcription=raw_transcript,
            processed_transcription=processed_transcript,
            word_count=metadata['word_count'],
            confidence_score=avg_confidence,
            speakers_detected=transcriptions[0]["speaker_count"] if transcriptions else 0,
            processing_time_seconds=processing_time,
            langchain_metadata=metadata,
        )

        # Step 6: Complete (100%)
        task.status = "completed"
        task.progress_percentage = 100
        task.current_step = "Complete"
        task.completed_at = timezone.now()
        task.save()
        cache.set(
            f"progress:{task_id}",
            {"progress": 100, "step": "Complete"},
            timeout=300
        )

        # Send completion email
        send_notification_email.delay(task_id, "completed")

        # Optional: Cleanup GCS file (disabled for debugging)
        # gcs_service.delete_file(task.gcs_uri)

        logger.info(f"Task {task_id} completed successfully")
        return {"task_id": str(task_id), "status": "completed"}

    except TranscriptionTask.DoesNotExist:
        logger.error(f"Task {task_id} not found")
        raise
    except Exception as exc:
        logger.error(f"Task {task_id} failed: {exc}")

        # Update task with error
        try:
            task = TranscriptionTask.objects.get(id=task_id)
            task.status = "failed"
            task.error_message = str(exc)
            task.save()

            # Send error email
            from apps.notifications.tasks import send_notification_email
            send_notification_email.delay(task_id, "error")
        except:
            pass

        # Retry if possible
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc, countdown=60 * (self.request.retries + 1))
        raise


@shared_task(bind=True, max_retries=3, default_retry_delay=60)
def process_chunk_task(self, task_id: str, chunk_index: int) -> Dict[str, Any]:
    """
    Process a single audio chunk for transcription.

    Called when a chunk is uploaded. Processes immediately for parallel execution.

    Args:
        task_id: UUID of the TranscriptionTask
        chunk_index: Index of the chunk to process

    Returns:
        Dict with chunk processing status
    """
    try:
        task = TranscriptionTask.objects.get(id=task_id)
        chunk = TranscriptionChunk.objects.get(task=task, chunk_index=chunk_index)

        # Update chunk status
        chunk.status = 'processing'
        chunk.started_at = timezone.now()
        chunk.save()

        # Update task status if needed
        if task.status in ['pending', 'uploading']:
            task.status = 'processing'
            if not task.started_at:
                task.started_at = timezone.now()
            task.save()

        # Update progress in cache
        cache.set(
            f"progress:{task_id}",
            {
                "progress": task.progress_percentage,
                "step": f"Processing chunk {chunk_index + 1}/{task.total_chunks}"
            },
            timeout=300
        )

        # Transcribe the chunk
        gcloud = GoogleCloudSpeechClient()
        result = gcloud.transcribe_gcs_uri(chunk.gcs_uri)

        # Save chunk results
        chunk.raw_transcription = result.get('transcript', '')
        chunk.confidence_score = result.get('confidence', 0)
        chunk.speakers_detected = result.get('speaker_count', 0)
        chunk.status = 'completed'
        chunk.completed_at = timezone.now()
        chunk.processing_time_seconds = (
            chunk.completed_at - chunk.started_at
        ).total_seconds()
        chunk.save()

        # Update task progress
        completed_chunks = TranscriptionChunk.objects.filter(
            task=task,
            status='completed'
        ).count()
        task.chunks_processed = completed_chunks

        # Calculate progress based on chunks processed (20-80% range)
        chunk_progress = 20 + int((completed_chunks / task.total_chunks) * 60)
        task.progress_percentage = chunk_progress
        task.current_step = f"Processed {completed_chunks}/{task.total_chunks} chunks"
        task.save()

        cache.set(
            f"progress:{task_id}",
            {"progress": chunk_progress, "step": task.current_step},
            timeout=300
        )

        logger.info(
            f"Chunk {chunk_index} of task {task_id} completed: "
            f"{len(chunk.raw_transcription)} chars"
        )

        # Check if all chunks are completed
        if completed_chunks >= task.total_chunks:
            # Trigger combining task
            combine_chunks_task.delay(task_id)

        return {
            "task_id": str(task_id),
            "chunk_index": chunk_index,
            "status": "completed"
        }

    except TranscriptionChunk.DoesNotExist:
        logger.error(f"Chunk {chunk_index} of task {task_id} not found")
        raise
    except TranscriptionTask.DoesNotExist:
        logger.error(f"Task {task_id} not found")
        raise
    except Exception as exc:
        logger.error(f"Chunk {chunk_index} of task {task_id} failed: {exc}")

        # Update chunk with error
        try:
            chunk = TranscriptionChunk.objects.get(
                task_id=task_id,
                chunk_index=chunk_index
            )
            chunk.status = 'failed'
            chunk.error_message = str(exc)
            chunk.save()
        except:
            pass

        # Retry if possible
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc, countdown=60 * (self.request.retries + 1))
        raise


@shared_task(bind=True, max_retries=2, default_retry_delay=30)
def combine_chunks_task(self, task_id: str) -> Dict[str, Any]:
    """
    Combine all chunk transcriptions into the final result.

    Called automatically when all chunks are processed.

    Args:
        task_id: UUID of the TranscriptionTask

    Returns:
        Dict with task completion status
    """
    try:
        task = TranscriptionTask.objects.get(id=task_id)

        # Verify all chunks are completed
        chunks = TranscriptionChunk.objects.filter(task=task).order_by('chunk_index')
        completed_chunks = chunks.filter(status='completed')

        if completed_chunks.count() < task.total_chunks:
            logger.warning(
                f"Not all chunks completed for task {task_id}: "
                f"{completed_chunks.count()}/{task.total_chunks}"
            )
            # Check if some chunks failed
            failed_chunks = chunks.filter(status='failed')
            if failed_chunks.exists():
                task.status = 'failed'
                task.error_message = f"{failed_chunks.count()} chunks failed to process"
                task.save()
                return {"task_id": str(task_id), "status": "failed"}

            # Otherwise, wait for more chunks
            return {"task_id": str(task_id), "status": "waiting"}

        # Update progress
        task.progress_percentage = 85
        task.current_step = "Combining transcriptions"
        task.save()
        cache.set(
            f"progress:{task_id}",
            {"progress": 85, "step": task.current_step},
            timeout=300
        )

        # Combine all transcriptions in order
        raw_transcript = " ".join([
            chunk.raw_transcription
            for chunk in chunks
            if chunk.raw_transcription
        ])

        # Calculate average confidence
        confidence_scores = [
            chunk.confidence_score
            for chunk in chunks
            if chunk.confidence_score is not None
        ]
        avg_confidence = (
            sum(confidence_scores) / len(confidence_scores)
            if confidence_scores else 0
        )

        # Total speakers (max across chunks for now)
        total_speakers = max(
            [chunk.speakers_detected for chunk in chunks],
            default=0
        )

        # Process with LangChain (90%)
        task.progress_percentage = 90
        task.current_step = "Formatting text"
        task.save()
        cache.set(
            f"progress:{task_id}",
            {"progress": 90, "step": task.current_step},
            timeout=300
        )

        text_processor = TextProcessor()
        processed_transcript = text_processor.clean_and_format(raw_transcript)
        metadata = text_processor.extract_metadata(processed_transcript)

        # Calculate total processing time
        processing_times = [
            chunk.processing_time_seconds
            for chunk in chunks
            if chunk.processing_time_seconds is not None
        ]
        total_processing_time = sum(processing_times)

        # Save result (95%)
        task.progress_percentage = 95
        task.current_step = "Saving results"
        task.save()
        cache.set(
            f"progress:{task_id}",
            {"progress": 95, "step": task.current_step},
            timeout=300
        )

        # Create or update transcription result
        TranscriptionResult.objects.update_or_create(
            task=task,
            defaults={
                'raw_transcription': raw_transcript,
                'processed_transcription': processed_transcript,
                'word_count': metadata['word_count'],
                'confidence_score': avg_confidence,
                'speakers_detected': total_speakers,
                'processing_time_seconds': total_processing_time,
                'langchain_metadata': metadata,
            }
        )

        # Complete task (100%)
        task.status = 'completed'
        task.progress_percentage = 100
        task.current_step = 'Complete'
        task.completed_at = timezone.now()
        task.save()
        cache.set(
            f"progress:{task_id}",
            {"progress": 100, "step": "Complete"},
            timeout=300
        )

        # Send completion email
        from apps.notifications.tasks import send_notification_email
        send_notification_email.delay(task_id, "completed")

        logger.info(f"Task {task_id} completed with {task.total_chunks} chunks")
        return {"task_id": str(task_id), "status": "completed"}

    except TranscriptionTask.DoesNotExist:
        logger.error(f"Task {task_id} not found")
        raise
    except Exception as exc:
        logger.error(f"Combining chunks for task {task_id} failed: {exc}")

        try:
            task = TranscriptionTask.objects.get(id=task_id)
            task.status = 'failed'
            task.error_message = f"Failed to combine chunks: {str(exc)}"
            task.save()

            from apps.notifications.tasks import send_notification_email
            send_notification_email.delay(task_id, "error")
        except:
            pass

        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc, countdown=30)
        raise