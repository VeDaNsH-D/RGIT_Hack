import { HANDOFF_STATES, HANDOFF_TERMINAL_STATES } from '../constants.js';

export const STATES = HANDOFF_STATES;
export const TERMINAL_STATES = HANDOFF_TERMINAL_STATES;

export class LifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
  }
}

export const ERROR_CODES = {
  TERMINAL_STATE: 'HANDOFF_TERMINAL_STATE',
  ILLEGAL_TRANSITION: 'HANDOFF_ILLEGAL_TRANSITION',
  WRONG_ACTOR: 'HANDOFF_WRONG_ACTOR',
};

// actor: who is allowed to fire this event — 'outgoing' (fromUserId) or
// 'incoming' (toUserId). `to` is the next state for events whose target is
// unconditional; SUBMIT has no `to` here because its destination depends on
// validation result, resolved in applyEvent below.
const TRANSITIONS = {
  DRAFT: {
    SUBMIT: { actor: 'outgoing' },
    CANCEL: { actor: 'outgoing', to: 'CANCELLED' },
  },
  EDITING: {
    SUBMIT: { actor: 'outgoing' },
    CANCEL: { actor: 'outgoing', to: 'CANCELLED' },
  },
  SUBMITTED: {
    ACKNOWLEDGE: { actor: 'incoming', to: 'ACKNOWLEDGED' },
    REQUEST_CLARIFICATION: { actor: 'incoming', to: 'CLARIFICATION_REQUESTED' },
    REJECT: { actor: 'incoming', to: 'REJECTED' },
    CANCEL: { actor: 'outgoing', to: 'CANCELLED' },
  },
  CLARIFICATION_REQUESTED: {
    RESPOND: { actor: 'outgoing', to: 'EDITING' },
    CANCEL: { actor: 'outgoing', to: 'CANCELLED' },
  },
  ACKNOWLEDGED: {},
  REJECTED: {},
  CANCELLED: {},
};

/**
 * Pure state transition. No DB access, no clock reads — callers resolve
 * `actorRole` (whether the caller is the outgoing or incoming party) and
 * `validationReady` (result of validation.js) before calling this.
 *
 * @param {object} args
 * @param {string} args.state - current handoff state
 * @param {'SUBMIT'|'ACKNOWLEDGE'|'REQUEST_CLARIFICATION'|'REJECT'|'RESPOND'|'CANCEL'} args.event
 * @param {'outgoing'|'incoming'} args.actorRole
 * @param {boolean} [args.validationReady] - required for SUBMIT
 * @returns {{ state: string }} the next state
 */
export function applyEvent({ state, event, actorRole, validationReady }) {
  if (TERMINAL_STATES.includes(state)) {
    throw new LifecycleError(
      ERROR_CODES.TERMINAL_STATE,
      `Handoff is in terminal state ${state} and accepts no further events`
    );
  }

  const transition = TRANSITIONS[state]?.[event];
  if (!transition) {
    throw new LifecycleError(
      ERROR_CODES.ILLEGAL_TRANSITION,
      `Event ${event} is not valid from state ${state}`
    );
  }

  if (transition.actor !== actorRole) {
    throw new LifecycleError(
      ERROR_CODES.WRONG_ACTOR,
      `Event ${event} must be fired by the ${transition.actor} party, not ${actorRole}`
    );
  }

  if (event === 'SUBMIT') {
    return { state: validationReady ? 'SUBMITTED' : 'EDITING' };
  }

  return { state: transition.to };
}
