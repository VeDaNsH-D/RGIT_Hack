// Pure helpers for the New Task modal's GitHub repository field and the task list's issue status.
// 'none' is the explicit "don't create a GitHub issue" choice; '' means nothing chosen yet.

export const NO_ISSUE = 'none'

/** With exactly one usable repository it is preselected; otherwise the user must choose. */
export function defaultRepositoryChoice(repositories = []) {
  return repositories.length === 1 && repositories[0].available ? String(repositories[0].id) : ''
}

export function filterRepositories(repositories, query) {
  const needle = query.trim().toLowerCase()
  return needle ? repositories.filter(repo => repo.fullName.toLowerCase().includes(needle)) : repositories
}

/** Whether the task form may be submitted for the repository-field state. */
export function repositoryFieldReady({ status, repositories = [], choice }) {
  if (status === 'loading') return false
  if (status === 'error') return choice === NO_ISSUE
  if (!repositories.length) return true
  if (choice === NO_ISSUE) return true
  const chosen = repositories.find(repo => String(repo.id) === choice)
  return Boolean(chosen?.available)
}

/** Body fields for POST /projects/:id/tasks. Omitted when the project has no repositories. */
export function githubRepositoryPayload({ status, repositories = [], choice }) {
  if (status !== 'ready' && choice !== NO_ISSUE) return {}
  if (choice === NO_ISSUE) return { githubRepositoryId: null }
  if (!repositories.length || !choice) return {}
  return { githubRepositoryId: Number(choice) }
}

export function githubStatusLabel(github) {
  if (!github) return null
  switch (github.status) {
    case 'synced': return `GitHub Issue #${github.issueNumber}`
    case 'pending': return 'Creating GitHub issue...'
    case 'failed': return 'Task created, but GitHub issue creation failed.'
    case 'not_connected': return 'Task created in Over2u. No GitHub repository is connected.'
    default: return null
  }
}

export const safeGithubUrl = url => (typeof url === 'string' && url.startsWith('https://github.com/') ? url : null)
