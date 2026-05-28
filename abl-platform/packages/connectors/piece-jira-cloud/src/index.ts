/* eslint-disable @typescript-eslint/no-explicit-any */
import { createPiece } from '@activepieces/pieces-framework';
import { jiraCloud as apJiraCloud } from '@activepieces/piece-jira-cloud';
import { jiraCloudAuth } from '@activepieces/piece-jira-cloud/src/auth';
import { addAttachmentToIssueAction } from './actions/add-attachment-to-issue';

// All AP jira-cloud actions except add_issue_attachment — replaced by URL-native version.
const apActions = Object.values(apJiraCloud.actions()).filter(
  (a) => a.name !== 'add_issue_attachment',
) as never[];

export const jiraCloud = createPiece({
  displayName: 'Jira Cloud',
  logoUrl: 'https://cdn.activepieces.com/pieces/jira.png',
  authors: [],
  description: 'Issue tracking and project management',
  auth: jiraCloudAuth as any,
  actions: [...apActions, addAttachmentToIssueAction as never],
  triggers: Object.values(apJiraCloud.triggers()) as never[],
});

export default jiraCloud;
