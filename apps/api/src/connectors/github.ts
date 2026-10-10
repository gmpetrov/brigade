// GitHub connector (REST API), on an installation of Brigade's GitHub App.
// It reaches only the repositories the customer picked when installing it.
import { z } from 'zod'
import { GITHUB_API } from './github-app.js'
import { json, op, type ConnectorContext, type ConnectorDefinition } from './types.js'

type User = { login: string } | null
type Label = { name: string } | string
type Repository = {
  full_name: string
  private: boolean
  description: string | null
  default_branch: string
  html_url: string
  language: string | null
  archived: boolean
  pushed_at: string | null
}
type Issue = {
  number: number
  title: string
  state: string
  body?: string | null
  user: User
  labels: Label[]
  assignees?: User[]
  comments: number
  created_at: string
  updated_at: string
  closed_at: string | null
  html_url: string
  pull_request?: unknown
}
type PullRequest = Issue & {
  draft?: boolean
  merged_at: string | null
  head: { ref: string; sha: string }
  base: { ref: string }
  mergeable?: boolean | null
  additions?: number
  deletions?: number
  changed_files?: number
}
type Comment = { id: number; user: User; body: string; created_at: string; html_url: string }
type Content = {
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  name: string
  path: string
  sha: string
  size: number
  encoding?: string
  content?: string
}
type Commit = {
  sha: string
  html_url: string
  commit: { message: string; author: { name: string; date: string } | null }
  author: User
}

const repository = (r: Repository) => ({
  name: r.full_name,
  private: r.private,
  description: r.description,
  defaultBranch: r.default_branch,
  language: r.language,
  archived: r.archived,
  pushedAt: r.pushed_at,
  url: r.html_url,
})
const issue = (i: Issue) => ({
  number: i.number,
  title: i.title,
  state: i.state,
  author: i.user?.login,
  labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
  assignees: i.assignees?.map((a) => a?.login),
  comments: i.comments,
  created: i.created_at,
  updated: i.updated_at,
  closed: i.closed_at,
  url: i.html_url,
})
const pull = (p: PullRequest) => ({
  ...issue(p),
  draft: p.draft,
  merged: p.merged_at,
  head: p.head.ref,
  base: p.base.ref,
})
const comment = (c: Comment) => ({
  id: c.id,
  author: c.user?.login,
  created: c.created_at,
  body: c.body.slice(0, 10_000),
  url: c.html_url,
})

const get = async <T>(ctx: ConnectorContext, path: string, query: Record<string, unknown> = {}) => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.append(key, String(value))
  return json<T>(await ctx.fetch(`${GITHUB_API}${path}${params.size ? `?${params}` : ''}`))
}
const send = async <T>(
  ctx: ConnectorContext,
  method: 'POST' | 'PATCH' | 'PUT',
  path: string,
  body: Record<string, unknown>,
) =>
  json<T>(
    await ctx.fetch(`${GITHUB_API}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

/** No "." or ".." segments: a call reaches exactly the object its target names. */
const segments = (value: string) =>
  value.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
const encodePath = (value: string) => value.split('/').map(encodeURIComponent).join('/')

const repo = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name, e.g. acme/web')
  .refine(segments, 'owner/name, e.g. acme/web')
  .describe('The repository as owner/name')
const filePath = z
  .string()
  .max(1000)
  .transform((p) => p.replace(/^\/+|\/+$/g, ''))
  .refine((p) => p === '' || segments(p), 'A path inside the repository, e.g. src/index.ts')
const ref = z.string().min(1).max(250).describe('A branch, tag or commit sha')
const branch = z
  .string()
  .regex(/^[\w./-]+$/, 'A branch name')
  .refine((b) => segments(b) && !b.endsWith('.lock'), 'A branch name')
const number = z.number().int().positive().describe('The issue or pull request number')
const limit = z.number().int().min(1).max(100).default(20)
const page = z.number().int().min(1).max(100).default(1)

const repoPath = (r: string) => `/repos/${encodePath(r)}`
const defaultBranch = async (ctx: ConnectorContext, r: string) =>
  (await get<Repository>(ctx, repoPath(r))).default_branch

/** A file's text, or what is in a directory. Binary and very large files are described, not read. */
async function readContent(ctx: ConnectorContext, r: string, path: string, at?: string) {
  const result = await get<Content | Content[]>(
    ctx,
    `${repoPath(r)}/contents${path ? `/${encodePath(path)}` : ''}`,
    { ref: at },
  )
  if (Array.isArray(result))
    return {
      path: path || '/',
      type: 'dir',
      entries: result.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size })),
    }
  if (result.type !== 'file' || result.encoding !== 'base64' || result.content === undefined)
    return {
      path: result.path,
      type: result.type,
      size: result.size,
      sha: result.sha,
      note: 'Too large or not a regular file; not read',
    }
  const bytes = Buffer.from(result.content, 'base64')
  if (bytes.includes(0))
    return { path: result.path, type: 'file', size: result.size, sha: result.sha, binary: true }
  const text = bytes.toString('utf8')
  return {
    path: result.path,
    type: 'file',
    size: result.size,
    sha: result.sha,
    text: text.slice(0, 100_000),
    truncated: text.length > 100_000,
  }
}

// biome-ignore lint: webhook payloads are untyped JSON
type Payload = any
const repositoryOption = {
  name: 'repository',
  label: 'Repository',
  placeholder: 'acme/website',
  help: 'owner/name. Empty: every repository Brigade can reach.',
}
const inRepository = ({ payload }: { payload: Payload }, options: Record<string, string>) =>
  !options.repository ||
  String(payload.repository?.full_name).toLowerCase() === options.repository.toLowerCase()
const excerpt = (text: string | null | undefined, max = 2000) =>
  text ? (text.length > max ? `${text.slice(0, max)}…` : text) : ''
const lines = (...l: (string | false | null | undefined)[]) => l.filter(Boolean).join('\n')

export const github: ConnectorDefinition = {
  kind: 'github',
  label: 'GitHub',
  auth: 'github_app',
  // Event types are GitHub's "event.action", from the GitHub App's webhook (routes/github-webhook.ts).
  triggers: {
    issue_opened: {
      label: 'Issue opened',
      description: 'Someone opens an issue.',
      options: [repositoryOption],
      events: ['issues.opened'],
      matches: inRepository,
      describe: ({ payload: p }) => ({
        title: `Issue opened in ${p.repository.full_name}: #${p.issue.number} ${p.issue.title}`,
        summary: lines(
          `#${p.issue.number} ${p.issue.title}, by ${p.issue.user?.login}.`,
          p.issue.html_url,
          excerpt(p.issue.body),
        ),
      }),
    },
    pull_request_opened: {
      label: 'Pull request opened',
      description: 'Someone opens a pull request.',
      options: [repositoryOption],
      events: ['pull_request.opened'],
      matches: inRepository,
      describe: ({ payload: p }) => ({
        title: `Pull request in ${p.repository.full_name}: #${p.pull_request.number} ${p.pull_request.title}`,
        summary: lines(
          `#${p.pull_request.number} ${p.pull_request.title}, by ${p.pull_request.user?.login}, ${p.pull_request.head?.ref} into ${p.pull_request.base?.ref}${p.pull_request.draft ? ' (draft)' : ''}.`,
          p.pull_request.html_url,
          excerpt(p.pull_request.body),
        ),
      }),
    },
    review_requested: {
      label: 'Review requested',
      description: 'Someone asks for a review on a pull request.',
      options: [
        repositoryOption,
        {
          name: 'reviewer',
          label: 'Only when this reviewer is asked',
          placeholder: 'octocat or team-slug',
          help: 'A GitHub username or team slug. Empty: any review request.',
        },
      ],
      events: ['pull_request.review_requested'],
      matches: (event, options) =>
        inRepository(event, options) &&
        (!options.reviewer ||
          [event.payload.requested_reviewer?.login, event.payload.requested_team?.slug]
            .filter(Boolean)
            .some((r: string) => r.toLowerCase() === options.reviewer!.toLowerCase())),
      describe: ({ payload: p }) => ({
        title: `Review requested in ${p.repository.full_name}: #${p.pull_request.number} ${p.pull_request.title}`,
        summary: lines(
          `${p.sender?.login} asked ${p.requested_reviewer?.login ?? p.requested_team?.name ?? 'a reviewer'} to review #${p.pull_request.number} ${p.pull_request.title}.`,
          p.pull_request.html_url,
        ),
      }),
    },
    comment: {
      label: 'New comment',
      description: 'Someone comments on an issue or pull request.',
      options: [repositoryOption],
      events: ['issue_comment.created', 'pull_request_review_comment.created'],
      matches: inRepository,
      describe: ({ payload: p }) => {
        const on = p.issue ?? p.pull_request
        return {
          title: `Comment on ${p.repository.full_name}#${on?.number}: ${on?.title}`,
          summary: lines(
            `${p.comment.user?.login} commented on #${on?.number} ${on?.title}${p.comment.path ? `, on ${p.comment.path}` : ''}.`,
            p.comment.html_url,
            excerpt(p.comment.body),
          ),
        }
      },
    },
    push: {
      label: 'Push to a branch',
      description: 'Commits are pushed.',
      options: [
        repositoryOption,
        {
          name: 'branch',
          label: 'Branch',
          placeholder: 'main',
          help: 'Empty: any branch.',
        },
      ],
      events: ['push'],
      matches: (event, options) =>
        inRepository(event, options) &&
        !event.payload.deleted &&
        String(event.payload.ref).startsWith('refs/heads/') &&
        (!options.branch || event.payload.ref === `refs/heads/${options.branch}`),
      describe: ({ payload: p }) => {
        const branch = String(p.ref).replace('refs/heads/', '')
        const commits = (p.commits ?? []) as {
          id: string
          message: string
          author?: { name?: string }
        }[]
        return {
          title: `Push to ${p.repository.full_name} ${branch}: ${commits.length} commit${commits.length === 1 ? '' : 's'}`,
          summary: lines(
            `${p.pusher?.name ?? p.sender?.login} pushed to ${branch}${p.forced ? ' (force)' : ''}.`,
            p.compare,
            ...commits
              .slice(-20)
              .map((c) => `- ${c.id.slice(0, 7)} ${c.message.split('\n')[0]} (${c.author?.name})`),
          ),
        }
      },
    },
  },
  operations: {
    github_list_repositories: op({
      description: 'List the repositories this GitHub connection can reach.',
      write: false,
      input: z.object({ limit, page }),
      target: () => 'repositories',
      run: async (ctx, i) => {
        const list = await get<{ total_count: number; repositories: Repository[] }>(
          ctx,
          '/installation/repositories',
          { per_page: i.limit, page: i.page },
        )
        return { total: list.total_count, repositories: list.repositories.map(repository) }
      },
    }),
    github_get_repository: op({
      description: "Read a repository's details, including its default branch.",
      write: false,
      input: z.object({ repository: repo }),
      target: (i) => i.repository,
      run: async (ctx, i) => repository(await get<Repository>(ctx, repoPath(i.repository))),
    }),
    github_read_file: op({
      description:
        'Read a file, or list a directory, at a branch, tag or commit (the default branch if omitted). An empty path lists the root.',
      write: false,
      input: z.object({ repository: repo, path: filePath.default(''), ref: ref.optional() }),
      target: (i) => `${i.repository}:${i.path || '/'}${i.ref ? `@${i.ref}` : ''}`,
      run: (ctx, i) => readContent(ctx, i.repository, i.path, i.ref),
    }),
    github_search_code: op({
      description:
        "Search code on the default branches, using GitHub's code search syntax (e.g. 'useAuth language:ts'). Give a repository to search only it.",
      write: false,
      input: z.object({ query: z.string().min(1).max(256), repository: repo.optional(), limit }),
      target: (i) => `code search ${i.query}${i.repository ? ` in ${i.repository}` : ''}`,
      run: async (ctx, i) => {
        const q = i.repository ? `${i.query} repo:${i.repository}` : i.query
        const result = await json<{
          total_count: number
          items: {
            path: string
            repository: { full_name: string }
            html_url: string
            text_matches?: { fragment: string }[]
          }[]
        }>(
          await ctx.fetch(
            `${GITHUB_API}/search/code?${new URLSearchParams({ q, per_page: String(i.limit) })}`,
            { headers: { accept: 'application/vnd.github.text-match+json' } },
          ),
        )
        return {
          total: result.total_count,
          results: result.items.map((item) => ({
            repository: item.repository.full_name,
            path: item.path,
            url: item.html_url,
            fragments: item.text_matches?.map((m) => m.fragment),
          })),
        }
      },
    }),
    github_list_commits: op({
      description:
        'List recent commits on a branch (the default branch if omitted), optionally touching one path.',
      write: false,
      input: z.object({ repository: repo, ref: ref.optional(), path: filePath.optional(), limit }),
      target: (i) => `commits of ${i.repository}${i.ref ? `@${i.ref}` : ''}`,
      run: async (ctx, i) => {
        const list = await get<Commit[]>(ctx, `${repoPath(i.repository)}/commits`, {
          sha: i.ref,
          path: i.path || undefined,
          per_page: i.limit,
        })
        return {
          commits: list.map((c) => ({
            sha: c.sha,
            message: c.commit.message.slice(0, 2000),
            author: c.author?.login ?? c.commit.author?.name,
            date: c.commit.author?.date,
            url: c.html_url,
          })),
        }
      },
    }),
    github_list_issues: op({
      description: 'List issues (not pull requests), most recently updated first.',
      write: false,
      input: z.object({
        repository: repo,
        state: z.enum(['open', 'closed', 'all']).default('open'),
        labels: z.array(z.string().max(100)).max(20).optional(),
        assignee: z.string().max(100).optional().describe('A login, "none" or "*"'),
        limit,
        page,
      }),
      target: (i) => `issues of ${i.repository}`,
      run: async (ctx, i) => {
        const list = await get<Issue[]>(ctx, `${repoPath(i.repository)}/issues`, {
          state: i.state,
          labels: i.labels?.join(','),
          assignee: i.assignee,
          sort: 'updated',
          per_page: i.limit,
          page: i.page,
        })
        return { issues: list.filter((x) => !x.pull_request).map(issue) }
      },
    }),
    github_get_issue: op({
      description: 'Read an issue or pull request with its body and comments.',
      write: false,
      input: z.object({ repository: repo, number }),
      target: (i) => `${i.repository}#${i.number}`,
      run: async (ctx, i) => {
        const path = `${repoPath(i.repository)}/issues/${i.number}`
        const [found, comments] = await Promise.all([
          get<Issue>(ctx, path),
          get<Comment[]>(ctx, `${path}/comments`, { per_page: 50 }),
        ])
        return {
          ...issue(found),
          pullRequest: Boolean(found.pull_request),
          body: found.body?.slice(0, 20_000) ?? null,
          commentList: comments.map(comment),
        }
      },
    }),
    github_list_pull_requests: op({
      description: 'List pull requests, most recently updated first.',
      write: false,
      input: z.object({
        repository: repo,
        state: z.enum(['open', 'closed', 'all']).default('open'),
        base: branch.optional().describe('Only pull requests into this branch'),
        limit,
        page,
      }),
      target: (i) => `pull requests of ${i.repository}`,
      run: async (ctx, i) => {
        const list = await get<PullRequest[]>(ctx, `${repoPath(i.repository)}/pulls`, {
          state: i.state,
          base: i.base,
          sort: 'updated',
          direction: 'desc',
          per_page: i.limit,
          page: i.page,
        })
        return { pullRequests: list.map(pull) }
      },
    }),
    github_get_pull_request: op({
      description:
        'Read a pull request: its description, branches and the changed files with their diffs (long diffs are cut).',
      write: false,
      input: z.object({ repository: repo, number }),
      target: (i) => `${i.repository}#${i.number}`,
      run: async (ctx, i) => {
        const path = `${repoPath(i.repository)}/pulls/${i.number}`
        const [found, files] = await Promise.all([
          get<PullRequest>(ctx, path),
          get<
            {
              filename: string
              status: string
              additions: number
              deletions: number
              patch?: string
            }[]
          >(ctx, `${path}/files`, { per_page: 100 }),
        ])
        let budget = 80_000
        return {
          ...pull(found),
          body: found.body?.slice(0, 20_000) ?? null,
          headSha: found.head.sha,
          mergeable: found.mergeable,
          additions: found.additions,
          deletions: found.deletions,
          changedFiles: found.changed_files,
          files: files.map((f) => {
            const patch = f.patch?.slice(0, Math.max(0, Math.min(budget, 10_000)))
            budget -= patch?.length ?? 0
            return {
              path: f.filename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
              patch,
              patchCut: (f.patch?.length ?? 0) > (patch?.length ?? 0),
            }
          }),
        }
      },
    }),

    github_create_issue: op({
      description: 'Open an issue.',
      write: true,
      input: z.object({
        repository: repo,
        title: z.string().min(1).max(256),
        body: z.string().max(65_000).optional().describe('Markdown'),
        labels: z.array(z.string().max(100)).max(20).optional(),
        assignees: z.array(z.string().max(100)).max(10).optional(),
      }),
      target: (i) => `new issue in ${i.repository}: ${i.title}`,
      run: async (ctx, { repository: r, ...fields }) =>
        issue(await send<Issue>(ctx, 'POST', `${repoPath(r)}/issues`, fields)),
    }),
    github_update_issue: op({
      description:
        "Change an issue or pull request's title, body, state, labels or assignees. Only the given fields change; labels and assignees replace the current ones.",
      write: true,
      input: z.object({
        repository: repo,
        number,
        title: z.string().min(1).max(256).optional(),
        body: z.string().max(65_000).optional(),
        state: z.enum(['open', 'closed']).optional(),
        stateReason: z.enum(['completed', 'not_planned', 'reopened']).optional(),
        labels: z.array(z.string().max(100)).max(20).optional(),
        assignees: z.array(z.string().max(100)).max(10).optional(),
      }),
      target: (i) =>
        `${i.repository}#${i.number}${i.state === 'closed' ? ' (close)' : i.state === 'open' ? ' (reopen)' : ''}`,
      run: async (ctx, { repository: r, number: n, stateReason, ...fields }) =>
        issue(
          await send<Issue>(ctx, 'PATCH', `${repoPath(r)}/issues/${n}`, {
            ...fields,
            state_reason: stateReason,
          }),
        ),
    }),
    github_comment: op({
      description: 'Comment on an issue or pull request.',
      write: true,
      input: z.object({
        repository: repo,
        number,
        body: z.string().min(1).max(65_000).describe('Markdown'),
      }),
      target: (i) => `comment on ${i.repository}#${i.number}`,
      run: async (ctx, i) =>
        comment(
          await send<Comment>(
            ctx,
            'POST',
            `${repoPath(i.repository)}/issues/${i.number}/comments`,
            {
              body: i.body,
            },
          ),
        ),
    }),
    github_create_branch: op({
      description: 'Create a branch from another branch (the default branch if omitted).',
      write: true,
      input: z.object({ repository: repo, branch, from: branch.optional() }),
      target: (i) => `new branch ${i.branch} in ${i.repository}`,
      run: async (ctx, i) => {
        const from = i.from ?? (await defaultBranch(ctx, i.repository))
        const base = await get<{ object: { sha: string } }>(
          ctx,
          `${repoPath(i.repository)}/git/ref/heads/${encodePath(from)}`,
        )
        await send(ctx, 'POST', `${repoPath(i.repository)}/git/refs`, {
          ref: `refs/heads/${i.branch}`,
          sha: base.object.sha,
        })
        return { branch: i.branch, from, sha: base.object.sha }
      },
    }),
    github_write_file: op({
      description:
        'Create or replace one file on a branch, as a commit. Work on a branch of your own and open a pull request, rather than committing to the default branch.',
      write: true,
      input: z.object({
        repository: repo,
        branch,
        path: filePath.refine((p) => p !== '', 'A file path'),
        content: z.string().max(1_000_000).describe('The whole new file, as text'),
        message: z.string().min(1).max(1000).describe('The commit message'),
      }),
      target: (i) => `commit ${i.path} to ${i.repository}@${i.branch}`,
      run: async (ctx, i) => {
        const path = `${repoPath(i.repository)}/contents/${encodePath(i.path)}`
        // Replacing a file needs its current sha; a missing file is created.
        const existing = await ctx.fetch(
          `${GITHUB_API}${path}?${new URLSearchParams({ ref: i.branch })}`,
        )
        const sha = existing.status === 404 ? undefined : (await json<Content>(existing)).sha
        const result = await send<{ commit: { sha: string; html_url: string } }>(ctx, 'PUT', path, {
          message: i.message,
          content: Buffer.from(i.content, 'utf8').toString('base64'),
          branch: i.branch,
          sha,
        })
        return {
          path: i.path,
          branch: i.branch,
          created: !sha,
          commit: result.commit.sha,
          url: result.commit.html_url,
        }
      },
    }),
    github_create_pull_request: op({
      description:
        'Open a pull request from a branch into another (the default branch if omitted).',
      write: true,
      input: z.object({
        repository: repo,
        title: z.string().min(1).max(256),
        head: branch.describe('The branch with the changes'),
        base: branch.optional().describe('The branch to merge into'),
        body: z.string().max(65_000).optional().describe('Markdown'),
        draft: z.boolean().default(false),
      }),
      target: (i) => `pull request ${i.head} → ${i.base ?? 'default branch'} in ${i.repository}`,
      run: async (ctx, { repository: r, ...fields }) =>
        pull(
          await send<PullRequest>(ctx, 'POST', `${repoPath(r)}/pulls`, {
            ...fields,
            base: fields.base ?? (await defaultBranch(ctx, r)),
          }),
        ),
    }),
  },
}
