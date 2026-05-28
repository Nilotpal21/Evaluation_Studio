import { z } from 'zod';

// ============================================================================
// Tool Input Schemas
// ============================================================================

export const NavigateArgsSchema = z.object({
  url: z.string().url(),
  waitFor: z.enum(['load', 'networkidle', 'domcontentloaded']).default('load'),
  timeout: z.number().min(0).max(60000).default(30000),
});

export const GetPageContentArgsSchema = z.object({
  includeHtml: z.boolean().default(true),
  includeText: z.boolean().default(true),
  includeScreenshot: z.boolean().default(false),
});

export const ClickElementArgsSchema = z.object({
  selector: z.string(),
  waitAfterClick: z.number().min(0).max(10000).default(1000),
  timeout: z.number().min(0).max(30000).default(10000),
});

export const TypeTextArgsSchema = z.object({
  selector: z.string(),
  text: z.string(),
  pressEnter: z.boolean().default(false),
  clearFirst: z.boolean().default(true),
  timeout: z.number().min(0).max(30000).default(10000),
});

export const ScrollArgsSchema = z.object({
  direction: z.enum(['down', 'up', 'to_bottom', 'to_top']),
  amount: z.number().min(0).optional(),
});

export const WaitForElementArgsSchema = z.object({
  selector: z.string(),
  timeout: z.number().min(0).max(60000).default(10000),
  state: z.enum(['attached', 'detached', 'visible', 'hidden']).default('visible'),
});

export const ExtractLinksArgsSchema = z.object({
  filter: z.string().optional(),
  includeExternal: z.boolean().default(false),
  limit: z.number().min(1).max(10000).optional(),
});

export const ExtractElementsArgsSchema = z.object({
  selector: z.string(),
  attributes: z.array(z.string()).optional(),
  limit: z.number().min(1).max(1000).optional(),
});

export const TakeScreenshotArgsSchema = z.object({
  selector: z.string().optional(),
  fullPage: z.boolean().default(false),
});

export const ExecuteJavaScriptArgsSchema = z.object({
  code: z.string(),
  returnValue: z.boolean().default(true),
});

export const GetPageStateArgsSchema = z.object({
  includeCookies: z.boolean().default(false),
  includeLocalStorage: z.boolean().default(false),
});

// ============================================================================
// Type Exports
// ============================================================================

export type NavigateArgs = z.infer<typeof NavigateArgsSchema>;
export type GetPageContentArgs = z.infer<typeof GetPageContentArgsSchema>;
export type ClickElementArgs = z.infer<typeof ClickElementArgsSchema>;
export type TypeTextArgs = z.infer<typeof TypeTextArgsSchema>;
export type ScrollArgs = z.infer<typeof ScrollArgsSchema>;
export type WaitForElementArgs = z.infer<typeof WaitForElementArgsSchema>;
export type ExtractLinksArgs = z.infer<typeof ExtractLinksArgsSchema>;
export type ExtractElementsArgs = z.infer<typeof ExtractElementsArgsSchema>;
export type TakeScreenshotArgs = z.infer<typeof TakeScreenshotArgsSchema>;
export type ExecuteJavaScriptArgs = z.infer<typeof ExecuteJavaScriptArgsSchema>;
export type GetPageStateArgs = z.infer<typeof GetPageStateArgsSchema>;

// ============================================================================
// Result Types
// ============================================================================

export interface NavigateResult {
  success: boolean;
  url: string;
  title: string;
  statusCode?: number;
  error?: string;
}

export interface PageContentResult {
  url: string;
  title: string;
  html?: string;
  text?: string;
  screenshot?: string; // base64 encoded
}

export interface ClickResult {
  success: boolean;
  selector: string;
  message: string;
  error?: string;
}

export interface TypeTextResult {
  success: boolean;
  selector: string;
  text: string;
  error?: string;
}

export interface ScrollResult {
  success: boolean;
  scrollPosition: {
    x: number;
    y: number;
  };
  maxScroll: {
    x: number;
    y: number;
  };
}

export interface WaitForElementResult {
  success: boolean;
  selector: string;
  found: boolean;
  error?: string;
}

export interface Link {
  text: string | null;
  href: string;
  title?: string;
  target?: string;
}

export interface ExtractLinksResult {
  links: Link[];
  count: number;
}

export interface ExtractedElement {
  text: string;
  html?: string;
  [key: string]: any; // For custom attributes
}

export interface ExtractElementsResult {
  elements: ExtractedElement[];
  count: number;
}

export interface ScreenshotResult {
  screenshot: string; // base64 encoded PNG
  format: 'png';
  width?: number;
  height?: number;
}

export interface ExecuteJavaScriptResult {
  success: boolean;
  result?: any;
  error?: string;
}

export interface PageState {
  url: string;
  title: string;
  scroll: {
    x: number;
    y: number;
    maxY: number;
  };
  viewport: {
    width: number;
    height: number;
  };
  cookies?: any[];
  localStorage?: Record<string, string>;
}

// ============================================================================
// Session & Browser Types
// ============================================================================

export interface BrowserSession {
  id: string;
  createdAt: Date;
  lastUsed: Date;
  url?: string;
}

export interface BrowserPoolOptions {
  maxBrowsers: number;
  maxPagesPerBrowser: number;
  sessionTimeout: number; // milliseconds
  headless: boolean;
}
