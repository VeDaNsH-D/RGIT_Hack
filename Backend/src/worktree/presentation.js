export const WORK_TREE_LANES = [
  { id: 'team', label: 'Team', color: '#c99cf5' },
  { id: 'development', label: 'Development', color: '#ffc06b' },
  { id: 'tasks', label: 'Tasks', color: '#ff8757' },
  { id: 'handoffs', label: 'Handoffs', color: '#92c8ff' },
  { id: 'knowledge', label: 'Knowledge', color: '#7ee0bb' },
  { id: 'project', label: 'Project & AI', color: '#d7b4ff' },
];
const labels = {
  PROJECT_CREATED: 'Project created', PROJECT_UPDATED: 'Project updated', MEMBER_ADDED: 'Teammate added',
  INVITATION_SENT: 'Invitation sent', INVITATION_ACCEPTED: 'Teammate joined', INVITATION_REVOKED: 'Invitation cancelled',
  TASK_CREATED: 'Task created', TASK_UPDATED: 'Task updated', TASK_OVERDUE: 'Task overdue',
  HANDOFF_CREATED: 'Handoff drafted', HANDOFF_UPDATED: 'Handoff updated', HANDOFF_SUBMITTED: 'Handoff submitted', HANDOFF_ACKNOWLEDGED: 'Ownership transferred',
  HANDOFF_CLARIFICATION_REQUESTED: 'Clarification requested', HANDOFF_REJECTED: 'Handoff rejected', HANDOFF_CONTEXT_SNAPSHOT: 'Handoff context captured', OWNERSHIP_TRANSFERRED: 'Ownership transferred',
  TEAM_CREATED: 'Team created', TEAM_UPDATED: 'Team updated', TEAM_MEMBER_ADDED: 'Team member added', TEAM_MEMBER_REMOVED: 'Team member removed', TEAM_MEMBER_ROLE_CHANGED: 'Team role changed', TEAM_OWNERSHIP_SET: 'Owning team set', TEAM_LINKED: 'Team added to project', TEAM_UNLINKED: 'Team removed from project', HANDOFF_CLARIFICATION_RESPONDED: 'Clarification answered', HANDOFF_CANCELLED: 'Handoff cancelled',
  NOTE_CREATED: 'Note added', NOTE_UPDATED: 'Note updated', NOTE_DELETED: 'Note removed',
  DOCUMENT_UPLOADED: 'Document uploaded', DOCUMENT_REINDEXED: 'Document reindexed', NOTION_PAGE_SYNCED: 'Notion page synced', NOTION_DISCONNECTED: 'Notion disconnected',
  EMAIL_CONVERSATION_IMPORTED: 'Conversation imported', EMAIL_WORKFLOW_PROPOSED: 'Workflow suggestions ready', EMAIL_WORKFLOW_CHANGE_APPLIED: 'Workflow change applied', EMAIL_PROPOSAL_DISMISSED: 'Suggestion dismissed',
  MCP_TOOL_APPLIED: 'AI project action', GITHUB_PUSH_RECEIVED: 'Code pushed', GITHUB_ISSUES_RECEIVED: 'Issue changed', GITHUB_PULL_REQUEST_RECEIVED: 'Pull request changed', GITHUB_REPOSITORY_RECEIVED: 'Repository changed',
  REPOSITORY_SYNC_STARTED: 'Repository sync started', REPOSITORY_SYNC_COMPLETED: 'Repository synced', REPOSITORY_SYNC_PARTIAL: 'Repository partially synced', REPOSITORY_SYNC_FAILED: 'Repository sync failed',
};
export const cleanText = (value, max = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').slice(0, max) : '';
export function eventLane(action) {
  if (/INVITATION|MEMBER|TEAMMATE|^TEAM_/.test(action)) return 'team';
  if (/GITHUB|REPOSITORY|COMMIT|PUSH/.test(action)) return 'development';
  if (/^TASK_/.test(action)) return 'tasks';
  if (/^HANDOFF_/.test(action)) return 'handoffs';
  if (/NOTE|DOCUMENT|NOTION|EMAIL|SOURCE|JIRA|SLACK/.test(action)) return 'knowledge';
  return 'project';
}
export function presentActivity(event) {
  const payload = event.payload || {};
  const action = String(event.action || 'PROJECT_EVENT');
  const label = labels[action] || action.toLowerCase().replace(/_/g, ' ').replace(/^./, char => char.toUpperCase());
  const description = cleanText(payload.title || payload.taskTitle || payload.name || payload.repository || payload.githubRepository || payload.githubRepositoryRemoved || payload.tool || payload.status);
  const details = {};
  for (const field of ['repository','branch','sha','tool','keyName','status','runId','priority','dueDate','fromStatus','toStatus','filename','fileName','message','provider']) if (typeof payload[field] === 'string') details[field] = cleanText(payload[field], 120);
  if (Number.isSafeInteger(payload.commitCount)) details.commits = payload.commitCount;
  return { id: `activity:${event._id}`, category: eventLane(action), action, label, description, actor: cleanText(event.actorId?.name) || (event.actorType === 'system' ? 'Integration' : 'Project member'), occurredAt: new Date(event.occurredAt).toISOString(), entityId: String(event.targetId || ''), kind: action.endsWith('_RECEIVED') ? 'trigger' : 'action', status: /FAILED|BLOCKED/.test(action) || payload.status === 'failed' ? 'failed' : /PARTIAL/.test(action) || payload.status === 'partial' ? 'partial' : /STARTED/.test(action) ? 'running' : 'completed', details };
}
