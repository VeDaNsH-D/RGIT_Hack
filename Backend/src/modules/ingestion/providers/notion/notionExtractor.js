/**
 * @file notionExtractor.js
 * @description Extracts structured content and markdown representation from Notion blocks and properties.
 */

export function extractRichText(richTextArray) {
  if (!Array.isArray(richTextArray)) {
    return '';
  }
  return richTextArray
    .map((item) => {
      if (!item) return '';
      let text = item.plain_text || item.text?.content || '';
      if (!text) return '';
      const annotations = item.annotations;
      if (annotations) {
        if (annotations.code) text = `\`${text}\``;
        if (annotations.bold) text = `**${text}**`;
        if (annotations.italic) text = `*${text}*`;
        if (annotations.strikethrough) text = `~~${text}~~`;
        if (annotations.underline) text = `<u>${text}</u>`;
      }
      if (item.href) {
        text = `[${text}](${item.href})`;
      }
      return text;
    })
    .join('');
}

export function extractPageTitle(page) {
  if (!page || typeof page !== 'object') return 'Untitled';
  const properties = page.properties;
  if (!properties || typeof properties !== 'object') {
    return 'Untitled';
  }
  for (const [key, prop] of Object.entries(properties)) {
    if (prop?.type === 'title') {
      const title = extractRichText(prop.title);
      if (title.trim()) return title.trim();
    }
  }
  for (const key of ['Name', 'Title', 'title', 'name']) {
    if (properties[key]) {
      const prop = properties[key];
      if (prop.type === 'title') {
        const title = extractRichText(prop.title);
        if (title.trim()) return title.trim();
      }
      if (prop.type === 'rich_text') {
        const title = extractRichText(prop.rich_text);
        if (title.trim()) return title.trim();
      }
    }
  }
  return 'Untitled';
}

export function formatBlockContent(block) {
  if (!block || typeof block !== 'object') return '';
  const type = block.type;
  if (!type || !block[type]) return '';
  const data = block[type];

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
      if (Array.isArray(data.rich_text)) {
        return extractRichText(data.rich_text);
      }
      return '';
  }
}

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
          ? prop.people.map((p) => p.name || p.id)
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
        extracted[key] = prop[type] !== undefined ? prop[type] : null;
        break;
    }
  }

  return extracted;
}

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
