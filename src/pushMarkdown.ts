import pfs from 'node:fs/promises';
import path from 'node:path';

import * as core from '@actions/core';
import * as github from '@actions/github';
import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';
import { markdownToRichText } from '@tryfabric/martian';
import graymatter from 'gray-matter';

import { getCtx } from './actionCtx';
import { getChangedMdFiles } from './git';
import { normalizeMarkdownForNotion, preflightNotionMarkdown } from './markdownCompat';
import { isNotionFrontmatter } from './notion';
import { retry, RetryError } from './retry';

export async function pushUpdatedMarkdownFiles() {
  const markdownFiles = getChangedMdFiles();
  console.log('Markdown files detected in latest commit', { markdownFiles });
  const fileFailures: { file: string; message: string }[] = [];
  for (const mdFileName of markdownFiles) {
    const res = await retry(() => pushMarkdownFile(mdFileName), {
      tries: 2,
    });

    if (res instanceof RetryError) {
      console.log('Failed to push markdown file', res);
      fileFailures.push({ file: mdFileName, message: res.message });
    }
  }
  if (fileFailures.length) {
    core.setFailed(`Files failed to push: ${JSON.stringify(fileFailures)}`);
  }
}

export async function pushMarkdownFile(mdFilePath: string) {
  const { notion, notionParentPageId } = getCtx();
  console.log('Starting markdown sync', { mdFilePath, notionParentPageId });
  const fileContents = await pfs.readFile(mdFilePath, { encoding: 'utf-8' });
  const fileMatter = graymatter(fileContents);

  if (!isNotionFrontmatter(fileMatter.data)) {
    throw new Error(`Invalid frontmatter format for ${mdFilePath}`);
  }

  const pageData = fileMatter.data;
  let pageId: string | undefined;
  let pageTitle: string | undefined;

  if (typeof pageData.notion_page === 'string') {
    console.log('Notion page frontmatter found', {
      frontmatter: fileMatter.data,
      file: mdFilePath,
    });

    pageId = pageData.notion_page.startsWith('http')
      ? path.basename(new URL(pageData.notion_page).pathname).split('-').at(-1)
      : pageData.notion_page;

    if (!pageId) {
      throw new Error('Could not get page ID from frontmatter');
    }

    if (pageData.title) {
      pageTitle = pageData.title;
    }
  } else {
    const canonicalTitle = path.basename(mdFilePath, '.md');
    console.log('No notion_page frontmatter, entering upsert mode', { canonicalTitle });
    const matches = (await notion.searchPagesByTitle(canonicalTitle, notionParentPageId || undefined)).filter(
      (page) => normalizeTitle(page.title) === normalizeTitle(canonicalTitle),
    );
    console.log('Notion title matches after normalization', {
      canonicalTitle,
      matchCount: matches.length,
      matches,
    });

    if (matches.length > 1) {
      const duplicatePageInfo = matches.map((match) => `${match.title} (${match.id})`).join(', ');
      throw new Error(
        `Multiple Notion pages matched "${canonicalTitle}" for ${mdFilePath}: ${duplicatePageInfo}`,
      );
    }

    if (matches.length === 1) {
      const match = matches[0];
      pageId = match.id;
      console.log(`Found existing Notion page for "${canonicalTitle}": ${match.id}`);
    } else {
      if (!notionParentPageId) {
        throw new Error(
          `No matching Notion page for "${canonicalTitle}" and notion-parent-page-id is missing`,
        );
      }

      pageId = await notion.createPage(notionParentPageId, canonicalTitle);
      console.log(`Created Notion page for "${canonicalTitle}": ${pageId}`);
    }

    pageTitle = canonicalTitle;
  }

  if (!pageId) {
    throw new Error(`Could not determine Notion page for ${mdFilePath}`);
  }

  console.log('Clearing page content');
  await notion.clearPage(pageId);

  if (pageTitle) {
    console.log(`Updating title: ${pageTitle}`);
    await notion.updatePageTitle(pageId, pageTitle);
  }

  const normalized = normalizeMarkdownForNotion(fileMatter.content);
  const preflightWarnings = preflightNotionMarkdown(normalized.markdown);
  console.log('Markdown compatibility summary', {
    file: mdFilePath,
    ...normalized.report,
    preflightWarnings: preflightWarnings.length,
  });
  if (preflightWarnings.length) {
    for (const warning of preflightWarnings) {
      console.log('Preflight warning', { file: mdFilePath, ...warning });
    }
  }

  console.log('Adding markdown content');
  try {
    await notion.appendMarkdown(pageId, normalized.markdown, [createWarningBlock(mdFilePath)]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Notion markdown validation error';
    const category = categorizeValidationIssue(message);
    throw new Error(
      [
        `Notion content append failed for ${mdFilePath}.`,
        `Likely issue category: ${category}.`,
        `Preflight warnings: ${preflightWarnings.length}.`,
        `Original error: ${message}`,
      ].join(' '),
    );
  }
  console.log('Markdown sync completed', { mdFilePath, pageId });
}

function normalizeTitle(value: string) {
  return value.trim().toLowerCase();
}

function categorizeValidationIssue(message: string) {
  const lowered = message.toLowerCase();
  if (lowered.includes('invalid url')) {
    return 'link-format';
  }
  if (lowered.includes('table row') || lowered.includes('table width')) {
    return 'table-structure';
  }
  if (lowered.includes('validation_error')) {
    return 'unsupported-markdown-construct';
  }
  return 'unknown';
}

function createWarningBlock(fileName: string): BlockObjectRequest {
  return {
    type: 'callout',
    callout: {
      rich_text: markdownToRichText(
        `This file is linked to Github. Changes must be made in the [markdown file](${github.context.payload.repository?.html_url}/blob/${github.context.sha}/${fileName}) to be permanent.`,
      ),
      icon: {
        emoji: '⚠',
      },
      color: 'yellow_background',
    },
  };
}
