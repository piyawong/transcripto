import { FileUpload } from '@/components/FileUpload/FileUpload';

export default function Home() {
  return (
    <div className="container mx-auto px-4 py-12">
      <div className="text-center mb-12">
        <h1 className="text-5xl font-bold mb-4 bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
          Audio Transcription Made Easy
        </h1>
        <p className="text-xl text-gray-600 max-w-2xl mx-auto">
          Upload your audio or video files and get accurate transcriptions powered by Google Cloud AI.
          No sign-up required. Just upload and track your progress.
        </p>
      </div>

      <div className="max-w-4xl mx-auto">
        <div className="grid md:grid-cols-3 gap-8 mb-12">
          <div className="text-center">
            <div className="bg-blue-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">📤</span>
            </div>
            <h3 className="font-semibold mb-2">Upload</h3>
            <p className="text-sm text-gray-600">
              Select your MP4, M4A, or MOV file and we'll convert it to optimal format
            </p>
          </div>

          <div className="text-center">
            <div className="bg-purple-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">⚡</span>
            </div>
            <h3 className="font-semibold mb-2">Process</h3>
            <p className="text-sm text-gray-600">
              AI-powered transcription with speaker detection and smart formatting
            </p>
          </div>

          <div className="text-center">
            <div className="bg-green-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">📄</span>
            </div>
            <h3 className="font-semibold mb-2">Download</h3>
            <p className="text-sm text-gray-600">
              Get your formatted transcript and download it as a text file
            </p>
          </div>
        </div>

        <FileUpload />
      </div>
    </div>
  );
}