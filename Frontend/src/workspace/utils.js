export function formatDate(value) { return value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : 'No due date' }
export function memberName(project, id) { return project?.context?.members.find(member => member.userId === id)?.name || 'Teammate' }
