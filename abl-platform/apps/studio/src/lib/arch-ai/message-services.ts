/**
 * Shared service singletons for the arch-ai message route and tool builders.
 * Centralised here so tool builder modules can import without re-creating instances.
 */
import {
  ArchJournal,
  SessionFile as SessionFileModel,
  ArchSessionAttachment as ArchSessionAttachmentModel,
  ArchSpecDocument,
  ArchProjectMemory,
} from '@agent-platform/database/models';
import mongoose from 'mongoose';
import {
  SessionService,
  JournalService,
  SpecDocumentService,
  ProjectMemoryService,
} from '@agent-platform/arch-ai';
import { ArchSessionModel } from '@agent-platform/arch-ai/models';
import { createFileStoreService } from '@agent-platform/arch-ai/session';
import { createArchAttachmentFileStore, createHybridArchFileStore } from '@/lib/arch-ai/file-store';

export const sessionService = new SessionService(ArchSessionModel);
export const journalService = new JournalService(ArchJournal);
export const legacyFileStoreService = createFileStoreService(SessionFileModel);
export const attachmentFileStoreService = createArchAttachmentFileStore(ArchSessionAttachmentModel);
export const fileStoreService = createHybridArchFileStore(
  legacyFileStoreService,
  attachmentFileStoreService,
);
export const specDocumentService = new SpecDocumentService(
  ArchSpecDocument,
  ArchSessionModel,
  mongoose.connection,
);
export const projectMemoryService = new ProjectMemoryService(ArchProjectMemory);
