import { API_URL } from '@/lib/config'

/** A library file's bytes; `download` asks the browser to save it. */
export const contentUrl = (id: string, download = false) =>
  `${API_URL}/api/library/${id}/content${download ? '?download' : ''}`
