import os
import logging
from typing import Dict, Any, Optional
from google.cloud import speech
from google.oauth2 import service_account

logger = logging.getLogger(__name__)


class GoogleCloudSpeechClient:
    """
    Client for Google Cloud Speech-to-Text API.

    Handles audio transcription from GCS URIs with support for
    long-running recognition and speaker diarization.
    """

    def __init__(self):
        """Initialize Speech-to-Text client with credentials."""
        # Load credentials from environment
        credentials_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
        if credentials_path and os.path.exists(credentials_path):
            credentials = service_account.Credentials.from_service_account_file(
                credentials_path
            )
            self.client = speech.SpeechClient(credentials=credentials)
        else:
            # Fall back to default credentials
            self.client = speech.SpeechClient()

    def transcribe_gcs_uri(
        self,
        gcs_uri: str,
        start_time: Optional[float] = None,
        end_time: Optional[float] = None
    ) -> Dict[str, Any]:
        """
        Transcribe audio from GCS URI, optionally with time bounds.

        Args:
            gcs_uri: GCS URI of the audio file (gs://bucket/path)
            start_time: Optional start time in seconds
            end_time: Optional end time in seconds

        Returns:
            Dict containing transcript, confidence score, and speaker count
        """
        try:
            # Configure speaker diarization (new API format)
            diarization_config = speech.SpeakerDiarizationConfig(
                enable_speaker_diarization=True,
                min_speaker_count=1,
                max_speaker_count=6,
            )

            # Configure recognition
            config = speech.RecognitionConfig(
                encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
                sample_rate_hertz=16000,
                language_code="th-TH",  # Thai language
                enable_automatic_punctuation=True,
                diarization_config=diarization_config,
                model="default",
            )

            # Use GCS URI directly
            audio = speech.RecognitionAudio(uri=gcs_uri)

            # Always use long_running_recognize for GCS files
            operation = self.client.long_running_recognize(
                config=config,
                audio=audio
            )

            # Wait for operation to complete (30 min timeout)
            response = operation.result(timeout=1800)

            # Extract transcript within time bounds if specified
            transcript = ""
            confidence_scores = []

            for result in response.results:
                # Check if result is within time bounds
                if start_time is not None and end_time is not None:
                    # Note: result_end_time is not always available
                    # This is a simplified implementation
                    result_start = getattr(result, 'result_end_time', None)
                    if result_start:
                        result_start = result_start.seconds
                        if result_start < start_time or result_start > end_time:
                            continue

                if result.alternatives:
                    alternative = result.alternatives[0]
                    transcript += alternative.transcript + " "
                    if hasattr(alternative, 'confidence'):
                        confidence_scores.append(alternative.confidence)

            # Calculate average confidence
            avg_confidence = (
                sum(confidence_scores) / len(confidence_scores)
                if confidence_scores else 0.0
            )

            return {
                "transcript": transcript.strip(),
                "confidence": avg_confidence,
                "speaker_count": 2,  # Default for diarization
            }
        except Exception as e:
            logger.error(f"Transcription failed for {gcs_uri}: {e}")
            raise