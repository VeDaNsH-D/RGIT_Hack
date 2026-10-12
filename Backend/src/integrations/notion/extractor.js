/**
 * Notion Content & Block Tree Extractor
 * 
 * Recursively parses Notion blocks and database properties into structured text
 * and markdown representations while preserving pagination and nested hierarchy.
 */

/**
 * Extracts plain text from a Notion rich text array.
 * 
 * @param {Array<{ plain_text?: string }>} [richTextArray]
 * @returns {string}
 */
export function extractRichText(richTextArray) {
  if (!Array.isArray(richTextArray)) return '';
  return richTextArray.map((rt) => rt.plain_text || '').join('');
}

/**
 * Extracts the title of a Notion page from its properties.
 * 
 * @param {object} page Notion page object
 * @returns {string}
 */
export function extractPageTitle(page) {
  if (!page || !page.properties || typeof page.properties !== 'object') {
    return 'Untitled Page';
  }

  // 1. Look for property with type === 'title'
  for (const prop of Object.values(page.properties)) {
    if (prop && prop.type === 'title' && Array.isArray(prop.title)) {
      const title = extractRichText(prop.title).trim();
      if (title) return title;
    }
  }

  // 2. Look for property named 'title' or 'Name'
  const namedTitle = page.properties.title || page.properties.Name;
  if (namedTitle && Array.isArray(namedTitle.title)) {
    const title = extractRichText(namedTitle.title).trim();
    if (title) return title;
  }

  return 'Untitled Page';
}

/**
 * Formats a single Notion block into a text / markdown line.
 * 
 * @param {object} block
 * @returns {string}
 */
export function formatBlockContent(block) {
  if (!block || typeof block !== 'object' || !block.type) return '';

  const type = block.type;
  const data = block[type] || {};

  switch (type) {
    case 'paragraph':
      return extractRichText(data.rich_text);

    case 'heading_1':
      return `# ${extractRichText(data.rich_text)}`;

    case 'heading_2':
      return `## ${extractRichText(data.rich_text)}`;

    case 'heading_3':
      return `### ${extractRichText(data.rich_text)}`;

    case 'bulleted_list_item':
      return `- ${extractRichText(data.rich_text)}`;

    case 'numbered_list_item':
      return `1. ${extractRichText(data.rich_text)}`;

    case 'to_do':
      return `[${data.checked ? 'x' : ' '}] ${extractRichText(data.rich_text)}`;

    case 'toggle':
      return `> **${extractRichText(data.rich_text)}**`;

    case 'quote':
      return `> ${extractRichText(data.rich_text)}`;

    case 'callout': {
      const icon = data.icon?.emoji || (data.icon?.external?.url ? `[icon]` : '');
      const prefix = icon ? `${icon} ` : '';
      return `> ${prefix}${extractRichText(data.rich_text)}`;
    }

    case 'code': {
      const codeText = extractRichText(data.rich_text);
      const lang = data.language || '';
      return `\`\`\`${lang}\n${codeText}\n\`\`\``;
    }

    case 'divider':
      return '---';

    case 'table_row':
      if (Array.isArray(data.cells)) {
        return `| ${data.cells.map((cell) => extractRichText(cell)).join(' | ')} |`;
      }
      return '';

    case 'bookmark':
      return data.url ? `[${data.url}](${data.url})` : '';

    default:
      // If block contains rich_text, extract it; otherwise return empty string
      if (Array.isArray(data.rich_text)) {
        return extractRichText(data.rich_text);
      }
      return '';
  }
}

/**
 * Extracts a map of human-readable property values from a database page.
 * 
 * @param {object} properties Notion page properties
 * @returns {Record<string, unknown>}
 */
export function extractProperties(properties) {
  if (!properties || typeof properties !== 'object') return {};

  const extracted = {};

  for (const [key, prop] of Object.entries(properties)) {
    if (!prop || typeof prop !== 'object') continue;

    const type = prop.type;
    switch (type) {
      case 'title':
        extracted[key] = extractRichText(prop.title);
        break;

      case 'rich_text':
        extracted[key] = extractRichText(prop.rich_text);
        break;

      case 'select':
        extracted[key] = prop.select?.name || null;
        break;

      case 'multi_select':
        extracted[key] = Array.isArray(prop.multi_select)
          ? prop.multi_select.map((item) => item.name)
          : [];
        break;

      case 'status':
        extracted[key] = prop.status?.name || null;
        break;

      case 'date':
        extracted[key] = prop.date
          ? { start: prop.date.start, end: prop.date.end }
          : null;
        break;

      case 'people':
        extracted[key] = Array.isArray(prop.people)
          ? prop.people.map((person) => person.name || person.id)
          : [];
        break;

      case 'checkbox':
        extracted[key] = Boolean(prop.checkbox);
        break;

      case 'number':
        extracted[key] = typeof prop.number === 'number' ? prop.number : null;
        break;

      case 'url':
        extracted[key] = prop.url || null;
        break;

      case 'email':
        extracted[key] = prop.email || null;
        break;

      default:
        // Keep raw property value where safe
        extracted[key] = prop[type] !== undefined ? prop[type] : null;
        break;
    }
  }

  return extracted;
}

/**
 * Recursively fetches all blocks and their nested children for a given container block ID,
 * following pagination cursors completely.
 * 
 * @param {import('./client.js').NotionClient} client
 * @param {string} blockId
 * @param {object} [options={}]
 * @param {number} [options.maxDepth=5] Max nested recursion depth
 * @param {number} [options.currentDepth=0] Internal depth tracker
 * @returns {Promise<string[]>} Formatted content lines
 */
export async function extractBlockHierarchy(client, blockId, { maxDepth = 5, currentDepth = 0 } = {}) {
  if (currentDepth > maxDepth) {
    const empty = [];
    empty.totalBlocks = 0;
    return empty;
  }

  const lines = [];
  let totalBlocks = 0;
  let cursor = undefined;
  let hasMore = true;

  while (hasMore) {
    const pageResult = await client.getBlockChildren(blockId, {
      startCursor: cursor,
      pageSize: 100,
    });

    const blocks = pageResult?.results || [];
    totalBlocks += blocks.length;

    for (const block of blocks) {
      const formatted = formatBlockContent(block);
      if (formatted) {
        const indent = '  '.repeat(currentDepth);
        lines.push(`${indent}${formatted}`);
      }

      // Check if block has nested child blocks
      if (block.has_children && currentDepth < maxDepth) {
        const childLines = await extractBlockHierarchy(client, block.id, {
          maxDepth,
          currentDepth: currentDepth + 1,
        });
        lines.push(...childLines);
        totalBlocks += childLines.totalBlocks || 0;
      }
    }

    hasMore = Boolean(pageResult?.has_more);
    cursor = pageResult?.next_cursor || undefined;
  }

  lines.totalBlocks = totalBlocks;
  return lines;
}
