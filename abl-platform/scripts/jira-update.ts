#!/usr/bin/env npx tsx

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  buildAdfDescription,
  JiraClient,
  updateTicket,
  type DescriptionSection,
} from './jira-client.js';

import {
  loadJiraEnvFromDotEnv,
  parseArgs,
  renderUsage,
  type JiraSectionInput,
} from './jira-update-lib.js';

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

function err(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function readSectionsFromFiles(
  paths: string[],
  defaultHeading: string,
): Promise<DescriptionSection[]> {
  const sections: DescriptionSection[] = [];

  for (const filePath of paths) {
    const content = (await readFile(resolve(process.cwd(), filePath), 'utf-8')).trim();
    if (!content) {
      continue;
    }
    sections.push({ heading: defaultHeading, content });
  }

  return sections;
}

function buildInlineSections(inputs: string[], defaultHeading: string): DescriptionSection[] {
  return inputs
    .map((content) => content.trim())
    .filter(Boolean)
    .map((content) => ({ heading: defaultHeading, content }));
}

function buildStructuredSections(inputs: JiraSectionInput[]): DescriptionSection[] {
  return inputs
    .map(({ heading, content }) => ({ heading: heading.trim(), content: content.trim() }))
    .filter(({ heading, content }) => heading.length > 0 && content.length > 0);
}

async function collectSections(
  inlineText: string[],
  files: string[],
  structured: JiraSectionInput[],
  defaultHeading: string,
): Promise<DescriptionSection[]> {
  return [
    ...buildInlineSections(inlineText, defaultHeading),
    ...(await readSectionsFromFiles(files, defaultHeading)),
    ...buildStructuredSections(structured),
  ];
}

async function collectNamedSections(
  inlineText: string[],
  files: string[],
  heading: string,
): Promise<DescriptionSection[]> {
  return [
    ...buildInlineSections(inlineText, heading),
    ...(await readSectionsFromFiles(files, heading)),
  ];
}

async function main(): Promise<void> {
  loadJiraEnvFromDotEnv();

  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    err('');
    err(renderUsage());
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    out(renderUsage());
    return;
  }

  const commentSections = await collectSections(
    parsed.commentText,
    parsed.commentFiles,
    parsed.commentSections,
    parsed.commentHeading,
  );
  const qaCommentSections = [
    ...(await collectNamedSections(parsed.qaShippedText, parsed.qaShippedFiles, 'Shipped')),
    ...(await collectNamedSections(
      parsed.qaVerificationText,
      parsed.qaVerificationFiles,
      'Verification',
    )),
    ...(await collectNamedSections(
      parsed.qaFollowUpText,
      parsed.qaFollowUpFiles,
      'Remaining follow-up',
    )),
  ];
  const descriptionSections = await collectSections(
    parsed.descriptionText,
    parsed.descriptionFiles,
    parsed.descriptionSections,
    parsed.descriptionHeading,
  );
  const allCommentSections = [...qaCommentSections, ...commentSections];

  const payload = {
    labels: parsed.setLabels.length > 0 ? parsed.setLabels : undefined,
    comment: allCommentSections.length > 0 ? buildAdfDescription(allCommentSections) : undefined,
    description:
      descriptionSections.length > 0 ? buildAdfDescription(descriptionSections) : undefined,
  };
  const hasFieldUpdates = payload.labels !== undefined || payload.description !== undefined;
  const hasClientActions =
    parsed.transition !== null ||
    parsed.transitionToStatus !== null ||
    parsed.assignee !== null ||
    parsed.assigneeAccountId !== null ||
    parsed.attachments.length > 0;

  if (parsed.dryRun) {
    out(
      JSON.stringify(
        {
          ticket: parsed.ticket,
          labels: payload.labels,
          commentSections: allCommentSections,
          descriptionSections,
          transition: parsed.transition,
          transitionToStatus: parsed.transitionToStatus,
          transitionPath: parsed.transitionPath,
          assignee: parsed.assignee,
          assigneeAccountId: parsed.assigneeAccountId,
          attachments: parsed.attachments,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (hasFieldUpdates) {
    await updateTicket(parsed.ticket!, {
      labels: payload.labels,
      description: payload.description,
    });
  }

  let transitionPathSummary: string | null = null;
  let assigneeSummary: string | null = null;

  if (hasClientActions) {
    const jira = new JiraClient();

    if (parsed.transition) {
      const transitionResult = await jira.transitionTicket(parsed.ticket!, parsed.transition);

      if (!transitionResult.success) {
        throw new Error(
          transitionResult.error?.message ??
            `Failed to transition ${parsed.ticket} with ${parsed.transition}`,
        );
      }
    }

    if (parsed.transitionToStatus) {
      const transitionResult = await jira.transitionTicketToStatus(
        parsed.ticket!,
        parsed.transitionToStatus,
        { transitionPath: parsed.transitionPath },
      );

      if (!transitionResult.success) {
        throw new Error(
          transitionResult.error?.message ??
            `Failed to transition ${parsed.ticket} to ${parsed.transitionToStatus}`,
        );
      }

      transitionPathSummary =
        transitionResult.data?.appliedTransitions.length === 0
          ? `${transitionResult.data.status} (already current)`
          : `${transitionResult.data?.status ?? parsed.transitionToStatus} via ${transitionResult.data?.appliedTransitions.join(' → ')}`;
    }

    if (parsed.assigneeAccountId) {
      const assignResult = await jira.assignTicketToAccountId(
        parsed.ticket!,
        parsed.assigneeAccountId,
      );

      if (!assignResult.success) {
        throw new Error(
          assignResult.error?.message ??
            `Failed to assign ${parsed.ticket} to ${parsed.assigneeAccountId}`,
        );
      }
      assigneeSummary = parsed.assigneeAccountId;
    } else if (parsed.assignee) {
      const assignResult = await jira.assignTicket(parsed.ticket!, parsed.assignee);

      if (!assignResult.success) {
        throw new Error(
          assignResult.error?.message ?? `Failed to assign ${parsed.ticket} to ${parsed.assignee}`,
        );
      }
      assigneeSummary = assignResult.data?.displayName ?? parsed.assignee;
    }

    if (parsed.attachments.length > 0) {
      const attachResult = await jira.attachFiles(
        parsed.ticket!,
        parsed.attachments.map((filePath) => resolve(process.cwd(), filePath)),
      );

      if (!attachResult.success) {
        throw new Error(
          attachResult.error?.message ?? `Failed to attach evidence to ${parsed.ticket}`,
        );
      }
    }
  }

  if (payload.comment !== undefined) {
    await updateTicket(parsed.ticket!, { comment: payload.comment });
  }

  const updatedParts = [
    payload.comment ? 'comment' : null,
    payload.description ? 'description' : null,
    payload.labels ? 'labels' : null,
    parsed.transition ? `transition → ${parsed.transition}` : null,
    transitionPathSummary ? `status → ${transitionPathSummary}` : null,
    assigneeSummary ? `assignee → ${assigneeSummary}` : null,
    parsed.attachments.length > 0 ? `attachments → ${parsed.attachments.length}` : null,
  ].filter(Boolean);

  out(`Updated ${parsed.ticket} (${updatedParts.join(', ')})`);
}

main().catch((error: unknown) => {
  err(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
