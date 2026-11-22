import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { cancelAwaitingSignature } from '@/lib/notifications/messages';
import { getNotificationCenter, useSessionNotifications } from '@/lib/notifications/store';
import { ClearSessionButton } from './activity-screen';

function SessionTab() {
  const entries = useSessionNotifications();
  return (
    <>
      <p data-testid="count">{entries.length}</p>
      <ClearSessionButton empty={entries.length === 0} />
    </>
  );
}

afterEach(cleanup);

describe('Clear session list (activity.md "Controls")', () => {
  it('empties the session list, then stays focusable with its reason', () => {
    act(() => getNotificationCenter().notify(cancelAwaitingSignature('order-1', 'request-1')));
    render(<SessionTab />);
    expect(screen.getByTestId('count').textContent).toBe('1');

    const button = screen.getByRole('button', { name: 'Clear session list' });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(button);

    expect(screen.getByTestId('count').textContent).toBe('0');
    expect(window.sessionStorage.getItem('atprice.activity.chipnet')).not.toContain('request-1');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    const reasonId = button.getAttribute('aria-describedby');
    expect(reasonId).not.toBeNull();
    expect(document.getElementById(reasonId ?? '')?.textContent).toBe('Nothing to clear.');
  });
});
