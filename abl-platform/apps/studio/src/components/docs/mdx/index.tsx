import Link from 'next/link';
import { Callout } from './Callout';
import { Mermaid } from './Mermaid';
import { Milestone } from './Milestone';
import { resolveDocHref, type DocLinkContext } from '../../../lib/docs/links';

export { Callout, Mermaid, Milestone };

interface CodeChildProps {
  className?: string;
  children?: string;
}

function CustomPre({
  children,
  ...props
}: React.ComponentPropsWithoutRef<'pre'> & { children?: React.ReactNode }) {
  // Check if the child is a mermaid code block
  const childElement = children as React.ReactElement<CodeChildProps> | undefined;
  const childProps = childElement?.props;
  if (childProps?.className === 'language-mermaid' && childProps.children) {
    return <Mermaid chart={childProps.children} />;
  }
  return (
    <pre {...props} className="docs-code-block overflow-x-auto rounded-lg p-4 text-sm">
      {children}
    </pre>
  );
}

function CustomCode({ children, className, ...props }: React.ComponentPropsWithoutRef<'code'>) {
  if (!className) {
    return (
      <code
        className="rounded bg-background-muted px-1.5 py-0.5 font-mono text-sm text-accent"
        {...props}
      >
        {children}
      </code>
    );
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

function CustomLink({
  href,
  children,
  linkContext,
  ...props
}: React.ComponentPropsWithoutRef<'a'> & { linkContext?: DocLinkContext }) {
  if (!href) {
    return <a {...props}>{children}</a>;
  }

  const resolvedHref = resolveDocHref(href, linkContext);

  if (
    href.startsWith('#') ||
    href.startsWith('mailto:') ||
    href.startsWith('tel:') ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)
  ) {
    return (
      <a href={resolvedHref} {...props}>
        {children}
      </a>
    );
  }

  return (
    <Link href={resolvedHref} {...props}>
      {children}
    </Link>
  );
}

export function createMdxComponents(linkContext?: DocLinkContext) {
  return {
    Callout,
    Milestone,
    Mermaid,
    pre: CustomPre,
    code: CustomCode,
    a: (props: React.ComponentPropsWithoutRef<'a'>) => (
      <CustomLink {...props} linkContext={linkContext} />
    ),
  };
}

export const mdxComponents = createMdxComponents();
