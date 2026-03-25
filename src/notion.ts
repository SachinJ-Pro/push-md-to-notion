import { Client } from '@notionhq/client';

/**
 * Class for managing Notion client state and methods needed for the action.
 */
export class NotionApi {
  private client: Client;
  constructor(token: string) {
    this.client = new Client({
      auth: token,
    });
  }

  public async updatePageTitle(pageId: string, title: string) {
    await this.client.pages.update({
      page_id: pageId,
      properties: {
        title: {
          type: 'title',
          title: [
            {
              type: 'text',
              text: { content: title },
            },
          ],
        },
      },
    });
  }

  public async createPage(parentPageId: string, title: string): Promise<string> {
    const page = await this.client.pages.create({
      parent: {
        page_id: parentPageId,
      },
      properties: {
        title: {
          title: [
            {
              type: 'text',
              text: { content: title },
            },
          ],
        },
      },
    });

    return page.id;
  }

  public async searchPagesByTitle(query: string, parentPageId?: string): Promise<NotionPageMatch[]> {
    const pages: NotionPageMatch[] = [];
    let hasMore = true;
    let startCursor: string | undefined;

    while (hasMore) {
      const response = await this.client.search({
        query,
        filter: {
          property: 'object',
          value: 'page',
        },
        page_size: 100,
        start_cursor: startCursor,
      });

      for (const result of response.results) {
        if (result.object !== 'page' || !hasPageProperties(result)) {
          continue;
        }
        if (parentPageId && !hasParentPageId(result, parentPageId)) {
          continue;
        }

        const title = getPageTitle(result);
        if (typeof title !== 'string') {
          continue;
        }

        pages.push({
          id: result.id,
          title,
        });
      }

      hasMore = response.has_more;
      startCursor = response.next_cursor ?? undefined;
    }

    return pages;
  }

  public async replacePageContentWithMarkdown(pageId: string, markdown: string) {
    await this.client.pages.updateMarkdown({
      page_id: pageId,
      type: 'replace_content',
      replace_content: {
        new_str: markdown,
        allow_deleting_content: true,
      },
    });
  }

  public async retrievePageMarkdown(pageId: string) {
    return this.client.pages.retrieveMarkdown({
      page_id: pageId,
    });
  }

  public async deletePage(pageId: string) {
    await this.client.pages.update({
      page_id: pageId,
      in_trash: true,
    });
  }
}

export interface NotionFrontmatter {
  notion_page?: string;
  notion_page_preview?: string;
  notion_page_prod?: string;
  title?: string;
  [key: string]: unknown;
}

export interface NotionPageMatch {
  id: string;
  title: string;
}

function getPageTitle(page: {
  properties: Record<string, { type: string; title?: { plain_text: string }[] }>;
}): string | undefined {
  for (const value of Object.values(page.properties)) {
    if (value.type !== 'title' || !Array.isArray(value.title)) {
      continue;
    }

    return value.title.map((piece) => piece.plain_text).join('');
  }

  return undefined;
}

function hasPageProperties(page: unknown): page is {
  properties: Record<string, { type: string; title?: { plain_text: string }[] }>;
} {
  return typeof page === 'object' && page !== null && 'properties' in page;
}

function hasParentPageId(
  page: unknown,
  parentPageId: string,
): page is {
  parent: {
    type: 'page_id';
    page_id: string;
  };
} {
  if (typeof page !== 'object' || page === null || !('parent' in page)) {
    return false;
  }

  const parent = (page as { parent: unknown }).parent;
  if (typeof parent !== 'object' || parent === null) {
    return false;
  }

  return (
    'type' in parent &&
    (parent as { type: string }).type === 'page_id' &&
    'page_id' in parent &&
    (parent as { page_id: string }).page_id.replaceAll('-', '') === parentPageId.replaceAll('-', '')
  );
}

export function isNotionFrontmatter(fm: unknown): fm is NotionFrontmatter {
  const castFm = fm as NotionFrontmatter;
  return (
    (typeof castFm?.notion_page === 'string' || typeof castFm?.notion_page === 'undefined') &&
    (typeof castFm?.notion_page_preview === 'string' ||
      typeof castFm?.notion_page_preview === 'undefined') &&
    (typeof castFm?.notion_page_prod === 'string' ||
      typeof castFm?.notion_page_prod === 'undefined') &&
    (typeof castFm?.title === 'string' || typeof castFm?.title === 'undefined')
  );
}
