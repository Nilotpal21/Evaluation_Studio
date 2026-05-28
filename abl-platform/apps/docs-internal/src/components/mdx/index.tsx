import { Callout } from './Callout';
import { FeatureMatrix } from './FeatureMatrix';
import { Mermaid } from './Mermaid';
import { Milestone } from './Milestone';
import { Reference } from './Reference';

export { Callout, FeatureMatrix, Mermaid, Milestone, Reference };

function CustomPre({ children, ...props }: any) {
  if (children?.props?.className === 'language-mermaid') {
    return <Mermaid chart={children.props.children} />;
  }
  return (
    <pre {...props} className="overflow-x-auto rounded-lg bg-gray-900 p-4 text-sm text-gray-100">
      {children}
    </pre>
  );
}

function CustomCode({ children, className, ...props }: any) {
  if (!className) {
    return (
      <code
        className="rounded bg-gray-100 px-1.5 py-0.5 text-sm font-mono text-pink-600"
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

export const mdxComponents = {
  Callout,
  FeatureMatrix,
  Milestone,
  Reference,
  Mermaid,
  pre: CustomPre,
  code: CustomCode,
};
