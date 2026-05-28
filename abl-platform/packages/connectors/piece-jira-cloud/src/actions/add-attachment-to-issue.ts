/* eslint-disable @typescript-eslint/no-explicit-any */
import { createAction, Property } from '@activepieces/pieces-framework';
import { jiraCloudAuth } from '@activepieces/piece-jira-cloud/src/auth';
import { sendJiraRequest } from '@activepieces/piece-jira-cloud/src/lib/common/index';
import {
  getProjectIdDropdown,
  getIssueIdDropdown,
} from '@activepieces/piece-jira-cloud/src/lib/common/props';
import { HttpMethod } from '@activepieces/pieces-common';
import FormData from 'form-data';
import path from 'path';
import { assertSafeFileUrl, MAX_FILE_BYTES } from '../security.js';

/**
 * Add Attachment to Issue — URL-native variant.
 *
 * AP piece does: URL → Buffer → base64 string → Buffer.from(base64) → FormData
 * This version does: URL → Buffer → FormData directly (skips base64 round-trip)
 * Peak memory: 1× file size instead of 2.33×
 */
export const addAttachmentToIssueAction = createAction({
  auth: jiraCloudAuth as any,
  name: 'add_issue_attachment',
  displayName: 'Add Attachment to Issue',
  description: 'Adds an attachment to an issue.',
  props: {
    projectId: getProjectIdDropdown() as any,
    issueId: getIssueIdDropdown({ refreshers: ['projectId'] }) as any,
    attachment: Property.ShortText({
      displayName: 'Attachment URL',
      description: 'Public URL of the file to attach.',
      required: true,
    }),
  },
  async run(context) {
    const { issueId, attachment: url } = context.propsValue;

    assertSafeFileUrl(url as string);
    const response = await fetch(url as string, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`Failed to fetch attachment: ${response.status} ${response.statusText}`);
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (!Number.isNaN(contentLength) && contentLength > MAX_FILE_BYTES) {
      throw new Error(`Attachment too large: ${contentLength} bytes exceeds the 25 MB limit`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_FILE_BYTES) {
      throw new Error(
        `Attachment too large after download: ${buffer.byteLength} bytes exceeds the 25 MB limit`,
      );
    }
    const filename = path.basename(new URL(url as string).pathname) || 'attachment';

    const formData = new FormData();
    formData.append('file', buffer, filename);

    const result = await (sendJiraRequest as any)({
      method: HttpMethod.POST,
      url: `issue/${issueId}/attachments`,
      auth: context.auth,
      headers: { 'X-Atlassian-Token': 'no-check', ...formData.getHeaders() },
      body: formData,
    });

    return result.body;
  },
});
