import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TemplatePreview } from '@/components/templates/TemplatePreview';
import { templateCatalog } from '@/lib/template-catalog';

describe('TemplatePreview', () => {
  it('renders every catalog example without falling back to the empty state', () => {
    const { rerender } = render(
      <TemplatePreview jsonData={JSON.stringify(templateCatalog[0]?.exampleJson ?? {})} />,
    );

    for (const entry of templateCatalog) {
      rerender(<TemplatePreview jsonData={JSON.stringify(entry.exampleJson)} />);
      expect(screen.queryByText('No preview available.')).not.toBeInTheDocument();
    }
  });

  it('sanitizes HTML preview content', () => {
    const { container } = render(
      <TemplatePreview
        jsonData={JSON.stringify({
          html: '<strong>Hello</strong><script>window.__xss__ = true</script>',
        })}
      />,
    );

    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
  });

  it('renders channel-native fallback previews with extracted summaries', () => {
    render(
      <TemplatePreview
        jsonData={JSON.stringify({
          slack:
            '{"text":"Approval required","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"Approve invoice INV-42"}}]}',
        })}
      />,
    );

    expect(screen.getByText('Slack Block Kit')).toBeInTheDocument();
    expect(screen.getByText('Approval required • Approve invoice INV-42')).toBeInTheDocument();
  });

  it('renders raw action sets alongside rich content previews', () => {
    render(
      <TemplatePreview
        jsonData={JSON.stringify({
          actions: {
            elements: [
              { id: 'approve', type: 'button', label: 'Approve', value: 'yes' },
              {
                id: 'reason',
                type: 'input',
                label: 'Reason',
                placeholder: 'Tell us why',
              },
            ],
            submit_label: 'Submit',
          },
        })}
      />,
    );

    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Tell us why')).toBeInTheDocument();
  });
});
