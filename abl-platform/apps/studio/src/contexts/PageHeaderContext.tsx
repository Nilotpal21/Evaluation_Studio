/**
 * PageHeaderContext
 *
 * Allows page components to register their title, breadcrumbs, and action
 * buttons into the AppShell content header bar without prop-drilling through
 * the routing layer.
 *
 * Usage in a page component (via ListPageShell):
 *   Pass `breadcrumbs` prop to <ListPageShell> for multi-level nav.
 *
 * Direct usage:
 *   const actions = useMemo(() => <Button>...</Button>, [deps]);
 *   useRegisterPageHeader(t('heading'), actions);
 *
 * IMPORTANT: always memoize the `actions` node with useMemo to prevent
 * infinite re-renders from new JSX object identity on every render.
 */

import {
  createContext,
  useContext,
  useState,
  useLayoutEffect,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import type { PageCrumb } from '../components/ui/PageBreadcrumb';

interface PageHeaderContextValue {
  title: string;
  description: string;
  actions: ReactNode;
  breadcrumbs: PageCrumb[];
  setTitle: (title: string) => void;
  setDescription: (description: string) => void;
  setActions: (actions: ReactNode) => void;
  setBreadcrumbs: (crumbs: PageCrumb[]) => void;
}

const PageHeaderContext = createContext<PageHeaderContextValue>({
  title: '',
  description: '',
  actions: null,
  breadcrumbs: [],
  setTitle: () => {},
  setDescription: () => {},
  setActions: () => {},
  setBreadcrumbs: () => {},
});

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [actions, setActions] = useState<ReactNode>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<PageCrumb[]>([]);

  return (
    <PageHeaderContext.Provider
      value={{
        title,
        description,
        actions,
        breadcrumbs,
        setTitle,
        setDescription,
        setActions,
        setBreadcrumbs,
      }}
    >
      {children}
    </PageHeaderContext.Provider>
  );
}

/** Read the current page header state — used by AppShell header bar. */
export function usePageHeaderState() {
  return useContext(PageHeaderContext);
}

/**
 * Register the current page's title, description, action buttons, and optional
 * breadcrumb trail into the AppShell header.
 *
 * Fires via useLayoutEffect so the title is visible on the first paint (no
 * flash of empty title during page transitions).
 *
 * @param title        Page display name, e.g. t('heading')
 * @param actions      Optional action buttons — MUST be memoized with useMemo
 * @param description  Optional description — shown as a tooltip on the page title
 * @param breadcrumbs  Optional breadcrumb trail — when provided, renders a full
 *                     breadcrumb nav instead of a plain title. Last crumb should
 *                     match `title`. Earlier crumbs with `href` are clickable.
 */
export function useRegisterPageHeader(
  title: string,
  actions?: ReactNode,
  description?: string,
  breadcrumbs?: PageCrumb[],
) {
  const { setTitle, setActions, setDescription, setBreadcrumbs } = useContext(PageHeaderContext);

  // Refs hold the latest values — written synchronously, read in effects.
  // This avoids putting object references (actions, breadcrumbs) in dep arrays
  // which would cause infinite re-render loops.
  const actionsRef = useRef(actions);
  const breadcrumbsRef = useRef(breadcrumbs);
  actionsRef.current = actions;
  breadcrumbsRef.current = breadcrumbs;

  // Sync title + description (primitives are safe as deps)
  useLayoutEffect(() => {
    setTitle(title);
    setDescription(description ?? '');
    setActions(actionsRef.current ?? null);
    setBreadcrumbs(breadcrumbsRef.current ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description]);

  // Clear on unmount
  useEffect(() => {
    return () => {
      setTitle('');
      setActions(null);
      setDescription('');
      setBreadcrumbs([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
