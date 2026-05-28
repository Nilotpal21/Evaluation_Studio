/* eslint-disable @typescript-eslint/no-explicit-any */
import { createPiece } from '@activepieces/pieces-framework';
import { googleDrive as apGoogleDrive } from '@activepieces/piece-google-drive';
import { googleDriveAuth } from '@activepieces/piece-google-drive/src/lib/auth';
import { googleDriveUploadFileAction } from './actions/upload-file';

// All AP google-drive actions except upload_gdrive_file — replaced by URL-native version.
const apActions = Object.values(apGoogleDrive.actions()).filter(
  (a) => a.name !== 'upload_gdrive_file',
) as never[];

export const googleDrive = createPiece({
  displayName: 'Google Drive',
  logoUrl: 'https://cdn.activepieces.com/pieces/google-drive.png',
  authors: [],
  description: 'Cloud storage and file backup',
  auth: googleDriveAuth as any,
  actions: [...apActions, googleDriveUploadFileAction as never],
  triggers: Object.values(apGoogleDrive.triggers()) as never[],
});

export default googleDrive;
