import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

function HealthBadge({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite">
      <span data-testid="health-label">{label}</span>
    </div>
  );
}

describe('jsdom + RTL + jest-dom pipeline', () => {
  it('renders a component and finds it via testing-library queries', () => {
    render(<HealthBadge label="ok" />);
    expect(screen.getByTestId('health-label')).toHaveTextContent('ok');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
