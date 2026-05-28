/**
 * Vitest setup for component tests
 *
 * NOTE: This is a .ts file (not .tsx) — avoid JSX syntax.
 * Use createElement or string returns for mock components.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { createElement } from 'react';

// Auto cleanup after each test
afterEach(() => {
  cleanup();
});

// Mock next-intl — return key as translation
vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    const t = (key: string, values?: Record<string, unknown>) => {
      return namespace ? `${namespace}.${key}` : key;
    };
    t.rich = (key: string) => (namespace ? `${namespace}.${key}` : key);
    t.raw = (key: string) => (namespace ? `${namespace}.${key}` : key);
    t.markup = (key: string) => (namespace ? `${namespace}.${key}` : key);
    t.has = () => true;
    return t;
  },
  useLocale: () => 'en',
  useMessages: () => ({}),
  useNow: () => new Date(),
  useTimeZone: () => 'UTC',
  useFormatter: () => ({
    number: (v: number) => String(v),
    dateTime: (v: Date) => v.toISOString(),
    relativeTime: (v: Date) => v.toISOString(),
  }),
  NextIntlClientProvider: ({ children }: any) => children,
}));

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

// Mock next/dynamic
vi.mock('next/dynamic', () => ({
  default: () => {
    const DynamicComponent = () => null;
    DynamicComponent.displayName = 'DynamicComponent';
    return DynamicComponent;
  },
}));

// Mock framer-motion — use createElement instead of JSX
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: (_target, prop) => {
        const Component = ({
          children,
          initial,
          animate,
          exit,
          transition,
          variants,
          whileHover,
          whileTap,
          layout,
          layoutId,
          ...htmlProps
        }: any) => {
          return createElement(
            String(prop) === 'aside'
              ? 'aside'
              : String(prop) === 'nav'
                ? 'nav'
                : String(prop) === 'span'
                  ? 'span'
                  : String(prop) === 'button'
                    ? 'button'
                    : 'div',
            htmlProps,
            children,
          );
        };
        Component.displayName = `motion.${String(prop)}`;
        return Component;
      },
    },
  ),
  AnimatePresence: ({ children }: any) => children,
  useMotionValue: () => ({ set: vi.fn(), get: () => 0 }),
  useTransform: () => ({ set: vi.fn(), get: () => 0 }),
}));

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-color-scheme: dark'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock IntersectionObserver
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock clipboard
Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(''),
  },
  writable: true,
});

// Mock lucide-react icons
vi.mock('lucide-react', () => {
  // Create a generic icon component using createElement
  const createIcon = (name: string) => {
    const IconComponent = (props: any) =>
      createElement(
        'svg',
        { ...props, 'data-testid': `icon-${name.toLowerCase()}` },
        createElement('title', null, name),
      );
    IconComponent.displayName = name;
    return IconComponent;
  };

  return {
    Activity: createIcon('Activity'),
    AlertCircle: createIcon('AlertCircle'),
    AlertTriangle: createIcon('AlertTriangle'),
    ArrowLeft: createIcon('ArrowLeft'),
    ArrowRight: createIcon('ArrowRight'),
    ArrowUp: createIcon('ArrowUp'),
    ArrowUpCircle: createIcon('ArrowUpCircle'),
    BarChart2: createIcon('BarChart2'),
    BarChart3: createIcon('BarChart3'),
    BookOpen: createIcon('BookOpen'),
    Bot: createIcon('Bot'),
    Brain: createIcon('Brain'),
    Bug: createIcon('Bug'),
    Check: createIcon('Check'),
    CheckCircle: createIcon('CheckCircle'),
    CheckCircle2: createIcon('CheckCircle2'),
    ChevronDown: createIcon('ChevronDown'),
    ChevronLeft: createIcon('ChevronLeft'),
    ChevronRight: createIcon('ChevronRight'),
    ChevronsLeft: createIcon('ChevronsLeft'),
    ChevronsRight: createIcon('ChevronsRight'),
    ChevronsUpDown: createIcon('ChevronsUpDown'),
    ChevronUp: createIcon('ChevronUp'),
    Circle: createIcon('Circle'),
    Clock: createIcon('Clock'),
    Code: createIcon('Code'),
    Code2: createIcon('Code2'),
    Coins: createIcon('Coins'),
    Copy: createIcon('Copy'),
    Cpu: createIcon('Cpu'),
    CreditCard: createIcon('CreditCard'),
    Database: createIcon('Database'),
    DollarSign: createIcon('DollarSign'),
    Download: createIcon('Download'),
    Edit: createIcon('Edit'),
    Edit2: createIcon('Edit2'),
    ExternalLink: createIcon('ExternalLink'),
    Eye: createIcon('Eye'),
    EyeOff: createIcon('EyeOff'),
    FileCode: createIcon('FileCode'),
    FileText: createIcon('FileText'),
    Flame: createIcon('Flame'),
    Folder: createIcon('Folder'),
    FolderInput: createIcon('FolderInput'),
    GitBranch: createIcon('GitBranch'),
    GitCompare: createIcon('GitCompare'),
    Globe: createIcon('Globe'),
    GripHorizontal: createIcon('GripHorizontal'),
    Hash: createIcon('Hash'),
    History: createIcon('History'),
    Info: createIcon('Info'),
    Key: createIcon('Key'),
    Layers: createIcon('Layers'),
    LayoutDashboard: createIcon('LayoutDashboard'),
    LayoutTemplate: createIcon('LayoutTemplate'),
    Loader2: createIcon('Loader2'),
    Lock: createIcon('Lock'),
    LogOut: createIcon('LogOut'),
    Mail: createIcon('Mail'),
    Maximize2: createIcon('Maximize2'),
    Menu: createIcon('Menu'),
    MessageSquare: createIcon('MessageSquare'),
    Mic: createIcon('Mic'),
    Minimize2: createIcon('Minimize2'),
    Minus: createIcon('Minus'),
    Moon: createIcon('Moon'),
    MoreVertical: createIcon('MoreVertical'),
    Move: createIcon('Move'),
    Network: createIcon('Network'),
    PanelLeftClose: createIcon('PanelLeftClose'),
    PanelLeftOpen: createIcon('PanelLeftOpen'),
    Paperclip: createIcon('Paperclip'),
    Phone: createIcon('Phone'),
    Play: createIcon('Play'),
    Plug: createIcon('Plug'),
    Plus: createIcon('Plus'),
    Radio: createIcon('Radio'),
    RefreshCw: createIcon('RefreshCw'),
    Rocket: createIcon('Rocket'),
    RotateCcw: createIcon('RotateCcw'),
    RotateCw: createIcon('RotateCw'),
    Save: createIcon('Save'),
    Search: createIcon('Search'),
    Send: createIcon('Send'),
    Server: createIcon('Server'),
    Settings: createIcon('Settings'),
    Settings2: createIcon('Settings2'),
    Shield: createIcon('Shield'),
    Smartphone: createIcon('Smartphone'),
    Sparkles: createIcon('Sparkles'),
    Star: createIcon('Star'),
    Sun: createIcon('Sun'),
    TableProperties: createIcon('TableProperties'),
    Tag: createIcon('Tag'),
    TestTube: createIcon('TestTube'),
    Trash2: createIcon('Trash2'),
    Upload: createIcon('Upload'),
    User: createIcon('User'),
    Users: createIcon('Users'),
    Wand2: createIcon('Wand2'),
    Wrench: createIcon('Wrench'),
    X: createIcon('X'),
    XCircle: createIcon('XCircle'),
    Zap: createIcon('Zap'),
    ZoomIn: createIcon('ZoomIn'),
    ZoomOut: createIcon('ZoomOut'),
    Power: createIcon('Power'),
    PowerOff: createIcon('PowerOff'),
    MessageCircle: createIcon('MessageCircle'),
    ArrowRightLeft: createIcon('ArrowRightLeft'),
    Lightbulb: createIcon('Lightbulb'),
    Workflow: createIcon('Workflow'),
    Calendar: createIcon('Calendar'),
    Building2: createIcon('Building2'),
    Square: createIcon('Square'),
    Volume2: createIcon('Volume2'),
    WifiOff: createIcon('WifiOff'),
    Pencil: createIcon('Pencil'),
  };
});
