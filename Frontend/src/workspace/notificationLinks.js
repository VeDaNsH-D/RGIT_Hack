export function notificationDestination(item) {
  if (!/^[a-f0-9]{24}$/i.test(item.projectId || '')) return '/dashboard'
  if (item.type?.startsWith('HANDOFF_') && /^[a-f0-9]{24}$/i.test(item.entityId || '')) return `/handoffs/${item.entityId}`
  return `/projects/${item.projectId}`
}
