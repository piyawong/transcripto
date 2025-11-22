import re
import logging
from typing import Dict, Any
from langchain.text_splitter import RecursiveCharacterTextSplitter

logger = logging.getLogger(__name__)


class TextProcessor:
    """
    Service for processing and formatting transcription text.

    Uses LangChain for intelligent text splitting and formatting
    to improve readability of transcriptions.
    """

    def __init__(self):
        """Initialize text splitter with optimal parameters."""
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000,
            chunk_overlap=200,
            separators=["\n\n", "\n", ". ", " ", ""]
        )

    def clean_and_format(self, raw_text: str) -> str:
        """
        Clean and format transcription text.

        Args:
            raw_text: Raw transcription text from Speech-to-Text API

        Returns:
            Cleaned and formatted text
        """
        try:
            # Remove common transcription artifacts
            text = raw_text.replace("[NOISE]", "")
            text = text.replace("[INAUDIBLE]", "...")
            text = text.replace("[CROSSTALK]", "")

            # Fix spacing issues
            text = re.sub(r'\s+', ' ', text)  # Multiple spaces to single
            text = re.sub(r'\s+([.,!?;:])', r'\1', text)  # Fix punctuation spacing

            # Ensure sentences start with capital letters after punctuation
            text = re.sub(
                r'([.,!?;:])\s*([a-z])',
                lambda m: m.group(1) + ' ' + m.group(2).upper(),
                text
            )

            # Capitalize first letter of each sentence
            sentences = text.split('. ')
            sentences = [s.strip().capitalize() for s in sentences if s.strip()]
            text = '. '.join(sentences)

            # Format into paragraphs using LangChain
            chunks = self.text_splitter.split_text(text)
            formatted_text = '\n\n'.join(chunks)

            return formatted_text
        except Exception as e:
            logger.error(f"Text processing failed: {e}")
            # Return original if processing fails
            return raw_text

    def extract_metadata(self, text: str) -> Dict[str, Any]:
        """
        Extract metadata from processed text.

        Args:
            text: Processed transcription text

        Returns:
            Dict containing text statistics
        """
        words = text.split()
        sentences = text.split('.')
        paragraphs = text.split('\n\n')

        # Calculate average word length
        avg_word_length = (
            sum(len(word) for word in words) / len(words)
            if words else 0
        )

        return {
            "word_count": len(words),
            "sentence_count": len(sentences),
            "paragraph_count": len(paragraphs),
            "average_word_length": avg_word_length,
        }