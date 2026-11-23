import { tr } from './i18n';
import { sendOversized, startNewChat } from './store';

/**
 * What the error card of a chat offers when the model's window is the problem. A conversation that no longer fits is carried on in a new
 * chat; a single message that is too large can go as a shortened preview. "Try the message again" would only fail the same way, so the card
 * never says it for these.
 */
export function contextRecovery(code: string | undefined): {
  next?: string;
  action?: string;
  onRetry?: () => void;
  secondary?: { label: string; onClick: () => void };
} {
  if (code === 'CONTEXT_MESSAGE_TOO_LARGE') {
    return {
      action: 'Send a shortened preview',
      onRetry: () => void sendOversized('preview'),
      secondary: { label: 'Start a new chat', onClick: () => startNewChat() },
    };
  }
  if (code === 'CONTEXT_WINDOW_EXCEEDED') {
    return {
      next: tr('Start a new chat when you’re ready.'),
      action: 'Start a new chat',
      onRetry: () => startNewChat(),
    };
  }
  return { next: tr('Try sending the message again.') };
}
