'use client'
import { ProjectRedirect } from '@/components/project-redirect'

/** A project's files: the library, opened at its folder. */
export default function ProjectLibrary() {
  return (
    <ProjectRedirect
      to={(p) =>
        p.folder ? `/app/library?folder=${encodeURIComponent(p.folder)}` : '/app/library'
      }
    />
  )
}
