/**
 * @file jiraExtractor.js
 * @description Robust Atlassian Document Format (ADF) parser and rich-text extractor for Jira.
 *
 * Safely parses structured ADF JSON documents or legacy markdown/plain-text into
 * clean, readable Markdown representations without losing formatting or throwing on
 * unexpected node types.
 */

/**
 * Applies ADF formatting marks (strong, em, code, strike, link) to inline text.
 * 
 * @param {string} text - Raw text string.
 * @param {Array<{ type: string, attrs?: Record<string, unknown> }>} [marks=[]] - Formatting marks.
 * @returns {string} Formatted markdown text.
 */
export function applyMarks(text, marks = []) {
  if (!text || !Array.isArray(marks) || marks.length === 0) {
    return text || '';
  }

  let formatted = text;
  for (const mark of marks) {
    if (!mark || typeof mark !== 'object') continue;
    switch (mark.type) {
      case 'strong':
        formatted = `**${formatted}**`;
        break;
      case 'em':
        formatted = `*${formatted}*`;
        break;
      case 'code':
        formatted = `\`${formatted}\``;
        break;
      case 'strike':
        formatted = `~~${formatted}~~`;
        break;
      case 'underline':
        formatted = `<u>${formatted}</u>`;
        break;
      case 'link':
        if (mark.attrs?.href) {
          formatted = `[${formatted}](${mark.attrs.href})`;
        }
        break;
      default:
        // Ignore unrecognized marks without error
        break;
    }
  }

  return formatted;
}

/**
 * Recursively converts an ADF inline or block node into a Markdown string representation.
 * 
 * @param {object} node - ADF node object.
 * @param {number} [depth=0] - Recursion depth for indentation.
 * @returns {string} Converted text representation.
 */
export function extractAdfNode(node, depth = 0) {
  if (!node || typeof node !== 'object') {
    return '';
  }

  // Handle plain text node with optional marks
  if (node.type === 'text') {
    return applyMarks(node.text || '', node.marks);
  }

  // Handle mentions
  if (node.type === 'mention') {
    const mentionText = node.attrs?.text || node.attrs?.id || 'user';
    return `@${mentionText.replace(/^@/, '')}`;
  }

  // Handle emojis
  if (node.type === 'emoji') {
    return node.attrs?.text || node.attrs?.shortName || '';
  }

  // Handle inline cards / links
  if (node.type === 'inlineCard' || node.type === 'blockCard') {
    const url = node.attrs?.url;
    return url ? `[${url}](${url})` : '';
  }

  // Handle horizontal rules
  if (node.type === 'rule') {
    return '\n---\n\n';
  }

  // Handle hard break
  if (node.type === 'hardBreak') {
    return '\n';
  }

  // Handle container node content
  const content = Array.isArray(node.content) ? node.content : [];

  switch (node.type) {
    case 'doc':
      return content.map((child) => extractAdfNode(child, depth)).join('').trim();

    case 'paragraph': {
      const pText = content.map((child) => extractAdfNode(child, depth)).join('');
      return pText ? `${pText}\n\n` : '\n';
    }

    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
      const prefix = '#'.repeat(level);
      const hText = content.map((child) => extractAdfNode(child, depth)).join('').trim();
      return `${prefix} ${hText}\n\n`;
    }

    case 'bulletList':
      return content
        .map((child) => extractAdfNode(child, depth))
        .join('') + '\n';

    case 'orderedList':
      return content
        .map((child, idx) => {
          const itemText = extractAdfNode(child, depth).trim();
          const indent = '  '.repeat(depth);
          return `${indent}${idx + 1}. ${itemText}\n`;
        })
        .join('') + '\n';

    case 'listItem': {
      const indent = '  '.repeat(depth);
      const childTexts = content
        .map((child) => {
          if (child.type === 'bulletList' || child.type === 'orderedList') {
            return '\n' + extractAdfNode(child, depth + 1);
          }
          return extractAdfNode(child, depth).trim();
        })
        .filter(Boolean)
        .join(' ');
      return `${indent}- ${childTexts}\n`;
    }

    case 'codeBlock': {
      const lang = node.attrs?.language || '';
      const codeText = content.map((child) => child.text || '').join('');
      return `\`\`\`${lang}\n${codeText}\n\`\`\`\n\n`;
    }

    case 'blockquote': {
      const quoteText = content.map((child) => extractAdfNode(child, depth)).join('').trim();
      const quotedLines = quoteText
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      return `${quotedLines}\n\n`;
    }

    case 'panel': {
      const panelType = node.attrs?.panelType || 'info';
      const label = panelType.charAt(0).toUpperCase() + panelType.slice(1);
      const inner = content.map((child) => extractAdfNode(child, depth)).join('').trim();
      return `> **[${label}]** ${inner}\n\n`;
    }

    case 'table': {
      const rows = content.map((child) => extractAdfNode(child, depth)).filter(Boolean);
      return rows.join('\n') + '\n\n';
    }

    case 'tableRow': {
      const cells = content.map((child) => {
        const text = extractAdfNode(child, depth).replace(/\n+/g, ' ').trim();
        return text || ' ';
      });
      return `| ${cells.join(' | ')} |`;
    }

    case 'tableHeader':
    case 'tableCell': {
      return content.map((child) => extractAdfNode(child, depth)).join('').trim();
    }

    default:
      // Graceful fallback for any unknown or extension nodes
      if (content.length > 0) {
        return content.map((child) => extractAdfNode(child, depth)).join('');
      }
      return node.text || '';
  }
}

/**
 * Safely converts Jira issue description (ADF JSON, raw markdown, or HTML/plain string)
 * into clean Markdown string.
 * 
 * @param {unknown} description - Raw description from Jira issue fields.
 * @returns {string} Normalized Markdown string (never null or undefined).
 */
export function extractDescription(description) {
  if (!description) {
    return '';
  }

  // If already a plain or markdown string
  if (typeof description === 'string') {
    return description.trim();
  }

  // If Atlassian Document Format (ADF) object
  if (typeof description === 'object') {
    try {
      const parsed = extractAdfNode(description);
      return parsed.replace(/\n{3,}/g, '\n\n').trim();
    } catch {
      // In case of unexpected parse error, fallback to string representation or empty
      return '';
    }
  }

  return String(description).trim();
}

/**
 * Extracts and formats structured issue properties into a clean summary list.
 * 
 * @param {object} fields - Jira issue fields object.
 * @returns {Record<string, unknown>}
 */
export function extractIssueProperties(fields = {}) {
  if (!fields || typeof fields !== 'object') {
    return {};
  }

  return {
    summary: fields.summary || '',
    status: fields.status?.name || null,
    statusCategory: fields.status?.statusCategory?.name || null,
    priority: fields.priority?.name || null,
    assignee: fields.assignee?.displayName || fields.assignee?.name || null,
    assigneeAccountId: fields.assignee?.accountId || null,
    reporter: fields.reporter?.displayName || fields.reporter?.name || null,
    reporterAccountId: fields.reporter?.accountId || null,
    creator: fields.creator?.displayName || fields.creator?.name || null,
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    components: Array.isArray(fields.components) ? fields.components.map((c) => c?.name).filter(Boolean) : [],
    dueDate: fields.duedate || null,
    issueType: fields.issuetype?.name || null,
    project: fields.project ? {
      id: fields.project.id,
      key: fields.project.key,
      name: fields.project.name,
    } : null,
    created: fields.created || null,
    updated: fields.updated || null,
    resolution: fields.resolution?.name || null,
    resolutionDate: fields.resolutiondate || null,
  };
}
