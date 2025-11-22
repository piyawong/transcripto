import os
import logging
from datetime import timedelta
from typing import Dict, List, Any
from google.cloud import storage
from google.oauth2 import service_account

logger = logging.getLogger(__name__)


class GCSService:
    """
    Service for Google Cloud Storage operations.

    Handles signed URL generation for direct browser uploads and
    file management operations in GCS.
    """

    def __init__(self):
        """Initialize GCS client with credentials."""
        credentials_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
        bucket_name = os.environ.get('GCS_BUCKET_NAME', 'transcripto-audio-files')

        if credentials_path and os.path.exists(credentials_path):
            credentials = service_account.Credentials.from_service_account_file(
                credentials_path
            )
            self.client = storage.Client(credentials=credentials)
        else:
            # Fall back to default credentials (for GCP environments)
            self.client = storage.Client()

        self.bucket = self.client.bucket(bucket_name)

    def generate_upload_signed_url(
        self,
        filename: str,
        content_type: str = 'audio/wav',
        blob_name: str = None
    ) -> Dict[str, str]:
        """
        Generate a signed URL for direct browser upload.

        Args:
            filename: Name of the file to upload
            content_type: MIME type of the file
            blob_name: Optional custom blob name (for chunk uploads)

        Returns:
            Dict containing upload_url, gcs_uri, and blob_name
        """
        try:
            # Use custom blob_name if provided, otherwise generate from filename
            if blob_name is None:
                blob_name = f"uploads/{filename}"
            blob = self.bucket.blob(blob_name)

            # Generate signed URL valid for 1 hour
            url = blob.generate_signed_url(
                version="v4",
                expiration=timedelta(hours=1),
                method="PUT",
                content_type=content_type,
            )

            return {
                "upload_url": url,
                "gcs_uri": f"gs://{self.bucket.name}/{blob_name}",
                "blob_name": blob_name
            }
        except Exception as e:
            logger.error(f"Failed to generate signed URL: {e}")
            raise

    def split_audio_into_chunks(
        self,
        gcs_uri: str,
        chunk_duration_ms: int = 1800000
    ) -> List[Dict[str, Any]]:
        """
        Split audio file in GCS into 30-minute chunks.

        Since audio is already in GCS, we'll use timestamps for virtual chunking.
        The Speech-to-Text API can process segments using timestamps.

        Args:
            gcs_uri: GCS URI of the audio file
            chunk_duration_ms: Duration of each chunk in milliseconds

        Returns:
            List of chunk specifications with start/end times
        """
        # Since audio is already in GCS, we'll use timestamps for virtual chunking
        # The Speech-to-Text API can process segments using timestamps

        # For simplicity, return chunk specifications
        # Real implementation would calculate based on duration
        chunks = []
        # Assuming we know the duration (this would be calculated from metadata)
        total_duration_ms = 7200000  # Example: 2 hours

        for start_ms in range(0, total_duration_ms, chunk_duration_ms):
            end_ms = min(start_ms + chunk_duration_ms, total_duration_ms)
            chunks.append({
                "gcs_uri": gcs_uri,
                "start_time": start_ms / 1000,  # Convert to seconds
                "end_time": end_ms / 1000
            })

        return chunks

    def delete_file(self, gcs_uri: str) -> None:
        """
        Delete file from GCS after processing.

        Args:
            gcs_uri: GCS URI of the file to delete
        """
        try:
            # Extract blob name from URI
            blob_name = gcs_uri.replace(f"gs://{self.bucket.name}/", "")
            blob = self.bucket.blob(blob_name)
            blob.delete()
            logger.info(f"Deleted GCS file: {gcs_uri}")
        except Exception as e:
            logger.warning(f"Failed to delete {gcs_uri}: {e}")