/* eslint-disable @typescript-eslint/no-explicit-any */
import { createAction, Property } from '@activepieces/pieces-framework';
import { googleDriveAuth } from '@activepieces/piece-google-drive/src/lib/auth';
import { common } from '@activepieces/piece-google-drive/src/lib/common/index';
import { httpClient, HttpMethod, AuthenticationType } from '@activepieces/pieces-common';
import FormData from 'form-data';
import mime from 'mime-types';
import path from 'path';
import { assertSafeFileUrl, MAX_FILE_BYTES } from '../security.js';

/**
 * Upload File — URL-native variant.
 *
 * AP piece does: URL → Buffer → base64 string → Buffer.from(base64) → FormData
 * This version does: URL → Buffer → FormData directly (skips base64 round-trip)
 * Peak memory: 1× file size instead of 2.33×
 */
export const googleDriveUploadFileAction = createAction({
  auth: googleDriveAuth as any,
  name: 'upload_gdrive_file',
  displayName: 'Upload File',
  description: 'Upload a file in your Google Drive',
  props: {
    fileName: Property.ShortText({
      displayName: 'File Name',
      description: 'The name of the file',
      required: true,
    }),
    file: Property.ShortText({
      displayName: 'File URL',
      description: 'Public URL of the file to upload.',
      required: true,
    }),
    parentFolder: (common as any).properties.parentFolder,
    include_team_drives: (common as any).properties.include_team_drives,
  },
  async run(context) {
    const { fileName, file: url, parentFolder, include_team_drives } = context.propsValue as any;

    assertSafeFileUrl(url as string);
    const response = await fetch(url as string, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (!Number.isNaN(contentLength) && contentLength > MAX_FILE_BYTES) {
      throw new Error(`File too large: ${contentLength} bytes exceeds the 25 MB limit`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_FILE_BYTES) {
      throw new Error(
        `File too large after download: ${buffer.byteLength} bytes exceeds the 25 MB limit`,
      );
    }

    const ext = path.extname(fileName || new URL(url as string).pathname).slice(1);
    const mimeType = mime.lookup(ext || '') || 'application/octet-stream';

    const meta: Record<string, unknown> = { mimeType, name: fileName };
    if (parentFolder) meta['parents'] = [parentFolder];

    const metaBuffer = Buffer.from(JSON.stringify(meta), 'utf-8');
    const form = new FormData();
    form.append('Metadata', metaBuffer, { contentType: 'application/json' });
    form.append('Media', buffer);

    const result = await httpClient.sendRequest({
      method: HttpMethod.POST,
      url: 'https://www.googleapis.com/upload/drive/v3/files',
      queryParams: {
        uploadType: 'multipart',
        supportsAllDrives: String(include_team_drives || false),
      },
      body: form,
      headers: { ...form.getHeaders() },
      authentication: {
        type: AuthenticationType.BEARER_TOKEN,
        token: (context.auth as any).access_token,
      },
    });

    return result.body;
  },
});
