/**
 * @file slackExtractor.js
 * @description Safe Slack mrkdwn and Block Kit extractor and permalink constructor.
 *
 * Safely unescapes Slack entity syntax (<@U123>, <#C123|name>, <https://link|label>)
 * and constructs provenance URLs without treating text as executable instructions.
 */

/**
 * Safely converts Slack mrkdwn string into clean Markdown.
 * Unescapes user mentions, channel mentions, special commands, and formatted links.
 * 
 * @param {string} rawText
 * @returns {string} Clean markdown string
 */
export function formatSlackText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return '';
  }

  let text = rawText;

  // 1. Unescape links: <http://example.com|Label> -> [Label](http://example.com)
  text = text.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '[$2]($1)');

  // 2. Unescape raw links: <http://example.com> -> http://example.com
  text = text.replace(/<(https?:\/\/[^>]+)>/g, '$1');

  // 3. Unescape user mentions: <@U12345|username> -> @username, <@U12345> -> @U12345
  text = text.replace(/<@([A-Z0-9]+)\|([^>]+)>/g, '@$2');
  text = text.replace(/<@([A-Z0-9]+)>/g, '@$1');

  // 4. Unescape channel mentions: <#C12345|general> -> #general, <#C12345> -> #C12345
  text = text.replace(/<#([A-Z0-9]+)\|([^>]+)>/g, '#$2');
  text = text.replace(/<#([A-Z0-9]+)>/g, '#$1');

  // 5. Unescape special command mentions: <!here>, <!channel>, <!everyone>
  text = text.replace(/<!(here|channel|everyone)>/g, '@$1');
  text = text.replace(/<!subteam\^[A-Z0-9]+\|@?([^>]+)>/g, '@$1');

  // 6. Unescape standard HTML entities in Slack
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');

  return text.trim();
}

/**
 * Extracts plain/markdown text from Block Kit elements if top-level text is empty.
 * 
 * @param {Array<object>} [blocks=[]]
 * @returns {string} Extracted text from blocks
 */
export function extractTextFromBlocks(blocks = []) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return '';
  }

  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;

    if (block.text && typeof block.text === 'object' && block.text.text) {
      parts.push(block.text.text);
    } else if (block.type === 'rich_text' && Array.isArray(block.elements)) {
      for (const section of block.elements) {
        if (Array.isArray(section.elements)) {
          for (const el of section.elements) {
            if (el.text) parts.push(el.text);
          }
        }
      }
    }
  }

  return formatSlackText(parts.join('\n\n'));
}

/**
 * Extracts normalized message text, prioritizing message.text with fallback to blocks.
 * 
 * @param {object} message - Raw Slack message object
 * @returns {string} Clean extracted text
 */
export function extractMessageText(message) {
  if (!message || typeof message !== 'object') {
    return '';
  }

  if (typeof message.text === 'string' && message.text.trim()) {
    return formatSlackText(message.text);
  }

  if (Array.isArray(message.blocks) && message.blocks.length > 0) {
    const blockText = extractTextFromBlocks(message.blocks);
    if (blockText) return blockText;
  }

  return '';
}

/**
 * Converts a Slack timestamp (e.g. '1728734400.123456') into a valid Date instance.
 * 
 * @param {string|number|unknown} ts
 * @returns {Date|undefined}
 */
export function parseSlackTs(ts) {
  if (!ts) return undefined;
  if (typeof ts === 'string' || typeof ts === 'number') {
    const numericSeconds = parseFloat(String(ts));
    if (!Number.isNaN(numericSeconds) && numericSeconds > 0) {
      const d = new Date(Math.round(numericSeconds * 1000));
      return Number.isNaN(d.getTime()) ? undefined : d;
    }
  }
  return undefined;
}

/**
 * Constructs the canonical web archive permalink for a Slack message.
 * e.g. https://myteam.slack.com/archives/C12345/p1728734400123456
 * 
 * @param {object} options
 * @param {string} options.channelId - Slack Channel ID (e.g. C12345)
 * @param {string} options.ts - Message timestamp string (e.g. '1728734400.123456')
 * @param {string} [options.teamDomain] - Slack workspace subdomain (e.g. 'myteam' or 'myteam.slack.com')
 * @param {string} [options.permalink] - Direct permalink if already fetched from Slack
 * @returns {string|undefined}
 */
export function constructMessageUrl({ channelId, ts, teamDomain, permalink } = {}) {
  if (permalink && typeof permalink === 'string') {
    return permalink;
  }

  if (!channelId || !ts) {
    return undefined;
  }

  const cleanTs = String(ts).replace('.', '');
  const rawDomain = teamDomain || process.env.SLACK_WORKSPACE_DOMAIN || '';
  if (!rawDomain) {
    return undefined;
  }

  const host = rawDomain.includes('.slack.com')
    ? rawDomain.replace(/\/+$/, '')
    : `https://${rawDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}.slack.com`;

  return `${host.startsWith('http') ? host : `https://${host}`}/archives/${encodeURIComponent(channelId)}/p${cleanTs}`;
}
