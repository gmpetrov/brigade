import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideoCamera,
  Presentation,
} from 'lucide-react'

/** A library file's icon, by what it is. */
export function fileIcon(contentType: string) {
  if (contentType.startsWith('image/')) return FileImage
  if (contentType.startsWith('video/')) return FileVideoCamera
  if (contentType.startsWith('audio/')) return FileAudio
  if (/spreadsheet|text\/csv|tab-separated/.test(contentType)) return FileSpreadsheet
  if (/presentation/.test(contentType)) return Presentation
  if (/zip/.test(contentType)) return FileArchive
  if (/json|yaml|xml|javascript|python|shellscript|text\/css|text\/html/.test(contentType))
    return FileCode
  if (contentType.startsWith('text/') || /pdf|wordprocessing/.test(contentType)) return FileText
  return File
}
