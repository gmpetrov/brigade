import { redirect } from 'next/navigation'

/** Projects are gone: a GitHub connection is all a repository needs. Old links land here. */
export default function Projects() {
  redirect('/app/pulls')
}
