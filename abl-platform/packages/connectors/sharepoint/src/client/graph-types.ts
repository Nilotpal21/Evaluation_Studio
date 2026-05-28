/**
 * Microsoft Graph API Types
 *
 * TypeScript types for SharePoint resources.
 */

// ─── Site ────────────────────────────────────────────────────────────────

export interface Site {
  id: string;
  name: string;
  displayName: string;
  webUrl: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  description?: string;
}

export interface SiteCollection {
  value: Site[];
  '@odata.nextLink'?: string;
}

// ─── Drive (Document Library) ────────────────────────────────────────────

export interface Drive {
  id: string;
  name: string;
  description?: string;
  driveType: string;
  webUrl: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  owner?: {
    user?: {
      displayName: string;
      email: string;
    };
  };
}

export interface DriveCollection {
  value: Drive[];
  '@odata.nextLink'?: string;
}

// ─── Drive Item (File/Folder) ────────────────────────────────────────────

export interface DriveItem {
  id: string;
  name: string;
  webUrl: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  size: number;
  file?: {
    mimeType: string;
    hashes?: {
      quickXorHash?: string;
      sha256Hash?: string;
    };
  };
  folder?: {
    childCount: number;
  };
  parentReference?: {
    driveId: string;
    siteId: string;
    path: string;
  };
  createdBy?: {
    user?: {
      displayName: string;
      email: string;
    };
  };
  lastModifiedBy?: {
    user?: {
      displayName: string;
      email: string;
    };
  };
}

export interface DriveItemCollection {
  value: DriveItem[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

// ─── Permission ──────────────────────────────────────────────────────────

/** Identity block shared by grantedToV2 and grantedToIdentitiesV2 entries */
export interface PermissionIdentity {
  user?: {
    displayName: string;
    email: string;
    id: string;
  };
  group?: {
    displayName: string;
    email: string;
    id: string;
  };
  siteUser?: {
    displayName: string;
    email: string;
    id: string;
  };
  /** SharePoint site group (e.g. "Members", "Visitors", "Owners") */
  siteGroup?: {
    displayName: string;
    id: string;
    loginName?: string;
  };
  /** SharePoint group with principalId (may appear alongside siteGroup) */
  sharePointGroup?: {
    id: string;
    title: string;
    principalId: string;
  };
}

export interface Permission {
  id: string;
  roles: string[];
  /** Single identity grant (most common) */
  grantedToV2?: PermissionIdentity;
  /** Array of identity grants — SharePoint may use this instead of grantedToV2 */
  grantedToIdentitiesV2?: PermissionIdentity[];
  link?: {
    type: string;
    scope: string;
    webUrl: string;
  };
}

/** Azure AD group returned by /groups?$filter=... */
export interface AzureADGroup {
  id: string;
  displayName: string;
  mail?: string;
}

export interface AzureADGroupCollection {
  value: AzureADGroup[];
}

export interface PermissionCollection {
  value: Permission[];
}

// ─── Group ───────────────────────────────────────────────────────────────

export interface GroupMember {
  id: string;
  displayName: string;
  mail?: string;
  userPrincipalName?: string;
}

export interface GroupMemberCollection {
  value: GroupMember[];
  '@odata.nextLink'?: string;
}

// ─── List ───────────────────────────────────────────────────────────────

export interface GraphList {
  id: string;
  name: string;
  displayName: string;
  description: string;
  list: {
    contentTypesEnabled: boolean;
    hidden: boolean;
    template: string;
  };
  webUrl: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
}

export interface GraphListCollection {
  value: GraphList[];
  '@odata.nextLink'?: string;
}

// ─── Column Definition ──────────────────────────────────────────────────

export interface GraphColumnDefinition {
  id: string;
  name: string;
  displayName: string;
  description: string;
  readOnly: boolean;
  hidden: boolean;
  required: boolean;
  indexed: boolean;
  text?: { allowMultipleLines: boolean; maxLength: number };
  number?: { decimalPlaces: string; maximum: number; minimum: number };
  dateTime?: { displayAs: string; format: string };
  boolean?: Record<string, never>;
  choice?: { allowTextEntry: boolean; choices: string[]; displayAs: string };
  lookup?: { allowMultipleValues: boolean; columnName: string; listId: string };
  personOrGroup?: { allowMultipleSelection: boolean; chooseFromType: string };
  currency?: { locale: string };
  calculated?: { format: string; formula: string; outputType: string };
  hyperlinkOrPicture?: { isPicture: boolean };
  contentApprovalStatus?: Record<string, never>;
}

export interface GraphColumnCollection {
  value: GraphColumnDefinition[];
  '@odata.nextLink'?: string;
}

// ─── Error Response ──────────────────────────────────────────────────────

export interface GraphErrorResponse {
  error: {
    code: string;
    message: string;
    innerError?: {
      date: string;
      'request-id': string;
      'client-request-id': string;
    };
  };
}
