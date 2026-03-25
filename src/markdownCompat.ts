export interface NormalizationReport {
  anchorLinksRemoved: number;
  tablesSeen: number;
  tableRowsNormalized: number;
}

export interface PreflightWarning {
  code: 'fragment-link' | 'table-row-mismatch' | 'inline-html';
  message: string;
}

export interface MarkdownNormalizationResult {
  markdown: string;
  report: NormalizationReport;
}

const TABLE_DELIMITER_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;
const FRAGMENT_LINK_RE = /\[([^\]]+)\]\(#([^)]+)\)/g;
const FRAGMENT_LINK_DETECT_RE = /\[([^\]]+)\]\(#([^)]+)\)/;
const INLINE_HTML_RE = /<[^>]+>/;

export function normalizeMarkdownForNotion(markdown: string): MarkdownNormalizationResult {
  const anchorLinksRemoved = [...markdown.matchAll(FRAGMENT_LINK_RE)].length;
  const withoutFragmentLinks = markdown.replace(FRAGMENT_LINK_RE, '$1');

  const lines = withoutFragmentLinks.split('\n');
  const normalizedLines: string[] = [];
  let tablesSeen = 0;
  let tableRowsNormalized = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i];
    const next = lines[i + 1];
    if (!isTableHeader(current, next)) {
      normalizedLines.push(current);
      continue;
    }

    tablesSeen += 1;
    const tableLines = [current, next];
    i += 2;

    while (i < lines.length && isPotentialTableRow(lines[i])) {
      tableLines.push(lines[i]);
      i += 1;
    }
    i -= 1;

    const normalizedTable = normalizeTableBlock(tableLines);
    tableRowsNormalized += normalizedTable.rowsNormalized;
    normalizedLines.push(...normalizedTable.lines);
  }

  return {
    markdown: normalizedLines.join('\n'),
    report: {
      anchorLinksRemoved,
      tablesSeen,
      tableRowsNormalized,
    },
  };
}

export function preflightNotionMarkdown(markdown: string): PreflightWarning[] {
  const warnings: PreflightWarning[] = [];
  if (FRAGMENT_LINK_DETECT_RE.test(markdown)) {
    warnings.push({
      code: 'fragment-link',
      message: 'Fragment-only links (#section) detected; Notion API rejects these URLs.',
    });
  }

  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!isTableHeader(lines[i], lines[i + 1])) {
      continue;
    }
    const expectedCells = splitTableRow(lines[i]).length;
    for (let j = i + 2; j < lines.length && isPotentialTableRow(lines[j]); j += 1) {
      const rowCells = splitTableRow(lines[j]).length;
      if (rowCells !== expectedCells) {
        warnings.push({
          code: 'table-row-mismatch',
          message: `Table row cell mismatch near line ${j + 1}. Expected ${expectedCells}, got ${rowCells}.`,
        });
        break;
      }
    }
  }

  if (INLINE_HTML_RE.test(markdown)) {
    warnings.push({
      code: 'inline-html',
      message: 'Inline HTML detected; conversion fidelity may vary in Notion.',
    });
  }

  return warnings;
}

function normalizeTableBlock(lines: string[]) {
  const headerCells = splitTableRow(lines[0]);
  const expectedCells = headerCells.length;
  const normalized: string[] = [normalizeTableLine(lines[0], expectedCells), lines[1]];
  let rowsNormalized = normalized[0] === lines[0] ? 0 : 1;

  for (let i = 2; i < lines.length; i += 1) {
    const nextLine = normalizeTableLine(lines[i], expectedCells);
    if (nextLine !== lines[i]) {
      rowsNormalized += 1;
    }
    normalized.push(nextLine);
  }

  return { lines: normalized, rowsNormalized };
}

function normalizeTableLine(line: string, expectedCells: number) {
  const cells = splitTableRow(line);
  if (cells.length === expectedCells) {
    return rebuildTableRow(cells);
  }

  if (cells.length > expectedCells) {
    const head = cells.slice(0, expectedCells - 1);
    const mergedLast = cells.slice(expectedCells - 1).join(' | ');
    return rebuildTableRow([...head, mergedLast]);
  }

  const padded = [...cells, ...Array.from({ length: expectedCells - cells.length }, () => '')];
  return rebuildTableRow(padded);
}

function rebuildTableRow(cells: string[]) {
  const escaped = cells.map((cell) => cell.replaceAll('|', '\\|').trim());
  return `| ${escaped.join(' | ')} |`;
}

function isPotentialTableRow(line: string) {
  return line.includes('|') && line.trim().length > 0;
}

function isTableHeader(line: string, nextLine: string | undefined) {
  return typeof nextLine === 'string' && line.includes('|') && TABLE_DELIMITER_RE.test(nextLine);
}

function splitTableRow(line: string) {
  const row = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let inCode = false;
  let current = '';
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i];
    if (char === '`' && row[i - 1] !== '\\') {
      inCode = !inCode;
      current += char;
      continue;
    }
    if (char === '|' && !inCode && row[i - 1] !== '\\') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}
