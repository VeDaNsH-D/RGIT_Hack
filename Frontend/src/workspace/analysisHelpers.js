// Pure helpers for rendering repository analysis status.

/** Plain-language coverage limitations, derived only from the numbers the backend reports. */
export function coverageNotes(coverage) {
  if (!coverage) return []
  const notes = []
  if (coverage.treeTruncated) notes.push('GitHub truncated the file listing.')
  if (coverage.tooLarge) notes.push(`${coverage.tooLarge} file(s) were too large to analyze.`)
  if (coverage.overBudget) notes.push(`${coverage.overBudget} file(s) were left out by the analysis budget.`)
  if (coverage.secretSkipped) notes.push(`${coverage.secretSkipped} file(s) were skipped because they appeared to contain credentials.`)
  if (coverage.fetchFailed) notes.push(`${coverage.fetchFailed} file(s) could not be fetched.`)
  if (coverage.binarySkipped) notes.push(`${coverage.binarySkipped} non-text file(s) were skipped.`)
  return notes
}

export function changeSummary(changes) {
  if (!changes) return null
  const parts = [['added', changes.added?.length], ['modified', changes.modified?.length], ['deleted', changes.deleted?.length], ['renamed', changes.renamed?.length]].filter(([, count]) => count)
  return parts.length ? parts.map(([label, count]) => `${count} ${label}`).join(', ') : 'No file changes'
}
