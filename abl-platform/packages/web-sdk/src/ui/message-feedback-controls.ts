import type { ChatClient } from '../chat/ChatClient.js';
import type { Message } from '../core/types.js';

const DEFAULT_COMMENT_MAX_LENGTH = 500;

type FeedbackRating = 'up' | 'down';

export function isMessageFeedbackEnabled(element: Element): boolean {
  const value = element.getAttribute('enable-feedback');
  return value !== null && value !== 'false' && value !== '0';
}

export function shouldRenderMessageFeedback(message: Message): boolean {
  return message.role === 'assistant' && !message.richContent?.feedback;
}

function formatFeedbackError(err: unknown): string {
  const code = (err as { code?: string } | undefined)?.code;
  switch (code) {
    case 'NOT_CONNECTED':
      return 'Reconnect to send feedback';
    case 'INVALID_TARGET':
      return "This message can't be rated yet";
    case 'DUPLICATE_FEEDBACK':
      return 'Already submitted';
    case 'INVALID_INPUT':
      return 'Comment too long';
    case 'STORAGE_FAILURE':
      return 'Server error - try again';
    case 'FEEDBACK_TIMEOUT':
      return 'Server did not respond';
    case 'FEEDBACK_PENDING':
      return 'Feedback in flight';
    default:
      return 'Could not send feedback';
  }
}

function setButtonState(
  upButton: HTMLButtonElement,
  downButton: HTMLButtonElement,
  rating: FeedbackRating,
  state: 'pending' | 'sent' | 'failed',
): void {
  upButton.classList.toggle('message-feedback-up', rating === 'up');
  downButton.classList.toggle('message-feedback-down', rating === 'down');
  upButton.disabled = state === 'pending' || state === 'sent';
  downButton.disabled = state === 'pending' || state === 'sent';
  upButton.setAttribute('aria-pressed', String(rating === 'up'));
  downButton.setAttribute('aria-pressed', String(rating === 'down'));
  if (state === 'sent') {
    upButton.classList.add('message-feedback-sent');
    downButton.classList.add('message-feedback-sent');
  }
}

export function appendMessageFeedbackControls(
  container: HTMLElement,
  message: Message,
  chat: ChatClient | null,
  commentMaxLength: number = DEFAULT_COMMENT_MAX_LENGTH,
): void {
  if (!shouldRenderMessageFeedback(message)) {
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'message-feedback';
  wrapper.dataset.messageId = message.id;

  const row = document.createElement('div');
  row.className = 'message-feedback-row';

  const upButton = document.createElement('button');
  upButton.type = 'button';
  upButton.className = 'message-feedback-btn';
  upButton.textContent = '👍';
  upButton.title = 'Thumbs up';
  upButton.setAttribute('aria-label', 'Thumbs up');
  upButton.setAttribute('aria-pressed', 'false');

  const downButton = document.createElement('button');
  downButton.type = 'button';
  downButton.className = 'message-feedback-btn';
  downButton.textContent = '👎';
  downButton.title = 'Thumbs down';
  downButton.setAttribute('aria-label', 'Thumbs down');
  downButton.setAttribute('aria-pressed', 'false');

  const status = document.createElement('span');
  status.className = 'message-feedback-status';

  row.appendChild(upButton);
  row.appendChild(downButton);
  row.appendChild(status);
  wrapper.appendChild(row);

  let commentBlock: HTMLDivElement | null = null;
  let commentInput: HTMLTextAreaElement | null = null;

  const removeCommentBlock = () => {
    commentBlock?.remove();
    commentBlock = null;
    commentInput = null;
  };

  const submit = async (rating: FeedbackRating, rawComment?: string) => {
    if (!chat) {
      status.textContent = 'Reconnect to send feedback';
      status.classList.add('message-feedback-error');
      return;
    }

    const trimmed = rawComment?.trim();
    removeCommentBlock();
    status.textContent = '';
    status.classList.remove('message-feedback-error');
    setButtonState(upButton, downButton, rating, 'pending');

    try {
      await chat.submitFeedback({
        messageId: message.id,
        ratingType: 'thumbs',
        ratingValue: rating === 'up' ? 1 : 0,
        ...(trimmed ? { feedbackText: trimmed } : {}),
      });
      setButtonState(upButton, downButton, rating, 'sent');
      status.textContent = rating === 'up' ? 'Thanks for the feedback' : 'Feedback recorded';
    } catch (err) {
      setButtonState(upButton, downButton, rating, 'failed');
      upButton.disabled = false;
      downButton.disabled = false;
      status.textContent = formatFeedbackError(err);
      status.classList.add('message-feedback-error');
    }
  };

  const showCommentUi = () => {
    if (commentBlock) return;
    status.textContent = '';
    status.classList.remove('message-feedback-error');
    upButton.classList.remove('message-feedback-up');
    downButton.classList.add('message-feedback-down');
    upButton.setAttribute('aria-pressed', 'false');
    downButton.setAttribute('aria-pressed', 'true');

    commentBlock = document.createElement('div');
    commentBlock.className = 'message-feedback-comment';

    commentInput = document.createElement('textarea');
    commentInput.className = 'message-feedback-comment-input';
    commentInput.maxLength = commentMaxLength;
    commentInput.rows = 2;
    commentInput.placeholder = 'Optional - what was wrong?';
    commentInput.setAttribute('aria-label', 'Optional - what was wrong?');
    commentBlock.appendChild(commentInput);

    const actions = document.createElement('div');
    actions.className = 'message-feedback-comment-actions';

    const counter = document.createElement('span');
    counter.className = 'message-feedback-counter';
    counter.textContent = `0/${commentMaxLength}`;
    commentInput.addEventListener('input', () => {
      if (!commentInput) return;
      if (commentInput.value.length > commentMaxLength) {
        commentInput.value = commentInput.value.slice(0, commentMaxLength);
      }
      counter.textContent = `${commentInput.value.length}/${commentMaxLength}`;
    });

    const skipButton = document.createElement('button');
    skipButton.type = 'button';
    skipButton.className = 'message-feedback-ghost-btn';
    skipButton.textContent = 'Skip';
    skipButton.addEventListener('click', () => {
      void submit('down');
    });

    const sendButton = document.createElement('button');
    sendButton.type = 'button';
    sendButton.className = 'message-feedback-primary-btn';
    sendButton.textContent = 'Send feedback';
    sendButton.addEventListener('click', () => {
      void submit('down', commentInput?.value);
    });

    actions.appendChild(counter);
    actions.appendChild(skipButton);
    actions.appendChild(sendButton);
    commentBlock.appendChild(actions);
    wrapper.appendChild(commentBlock);
    commentInput.focus();
  };

  upButton.addEventListener('click', () => {
    void submit('up');
  });
  downButton.addEventListener('click', showCommentUi);

  container.appendChild(wrapper);
}
