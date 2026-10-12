/**
 * Exact cross-references between Jira and everything else in a context pack.
 *
 * A Jira key (PROJ-123) written in a PR title, commit subject, issue, Slack message, note or document excerpt is a
 * deliberate human link, so unlike the lexical hints it is reliable. Each Jira source gets `mentionedIn` (ids of other
 * sources that name its key) and each other source gets `jira` (the keys it names), letting the model connect tracked
 * work to the code and discussion that touches it without searching for it.
 */

const KEY_IN_TEXT = /\b([A-Z][A-Z0-9_]{1,19}-\d{1,6})\b/g;

export function addJiraKeyLinks(sources, { maxPerSource = 3 } = {}) {
  const jira = new Map(); // key -> jira source
  for (const s of sources) if (s.provider === 'jira' && s.metadata?.key) jira.set(s.metadata.key, s);
  if (!jira.size) return sources;
  const mentions = new Map(); // key -> ids
  for (const s of sources) {
    if (s.provider === 'jira') continue;
    const text = `${s.title || ''} ${s.content || ''}`;
    const keys = [...new Set([...text.matchAll(KEY_IN_TEXT)].map((m) => m[1]).filter((k) => jira.has(k)))].slice(0, maxPerSource);
    if (!keys.length) continue;
    s.metadata = { ...s.metadata, jira: keys };
    for (const k of keys) mentions.set(k, [...(mentions.get(k) || []), s.id]);
  }
  for (const [k, ids] of mentions) {
    const j = jira.get(k);
    j.metadata = { ...j.metadata, mentionedIn: ids.slice(0, maxPerSource) };
  }
  return sources;
}
